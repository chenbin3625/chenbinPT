<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { Modal } from "ant-design-vue";
import { EyeInvisibleOutlined, EyeOutlined, SyncOutlined, UploadOutlined } from "@ant-design/icons-vue";
import { isEmpty } from "es-toolkit/compat";
import { jsZipBlobToBackupData, getBackupWarnings } from "@ptd/backupServer/utils.ts";
import type { IBackupData } from "@ptd/backupServer";
import { useRouter } from "vue-router";

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { sendMessage } from "@/messages.ts";
import { BackupFields, type TBackupFields, type IRestoreOptions } from "@/shared/types.ts";

import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import { analyzeRestoreSecurity, summarizeRestoreResult } from "./restoreSecurity.ts";
import { compareVersion } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { t } = useI18n();
const router = useRouter();

type TRestoreMetaData = { type: "file" } | { type: "remote"; server: string; path: string };

const { restoreMetadata = { type: "file" } } = defineProps<{
  restoreMetadata?: TRestoreMetaData;
}>();

const currentStep = ref<TRestoreMetaData["type"] | "restore">("file");
const decryptKey = ref<string>("");
const showDecryptKey = ref<boolean>(false);
const isDecryptKeyValid = ref<boolean>(true);

const restoreData = shallowRef<IBackupData>();

/**
 * S-1：恢复选项。
 *
 * `restoreBackupServers` 由 offscreen 侧的恢复流程消费，用于决定是否把备份里的
 * `metadata.backupServers`（服务器地址 + 凭据）一起恢复，必须默认为 false。
 */
const restoreOptions = ref<IRestoreOptions>({
  fields: [],
  expandCookieMinutes: 0,
  keepExistUserInfo: true,
  // 默认关闭：一份他人分享的备份可以借备份服务器配置把自动备份指向攻击者端点
  restoreBackupServers: false,
});

/** S-1：备份服务器配置 / 敏感字段 / 未勾选开关时的后果，见 restoreSecurity.ts */
const restoreSecurity = computed(() => analyzeRestoreSecurity(restoreData.value, restoreOptions.value));

/** 解析备份文件时被丢弃的条目（形状不符等），由 packages/backupServer/utils.ts 在解析阶段记录 */
const backupParseWarnings = computed(() => getBackupWarnings(restoreData.value ?? {}));

const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

function buildBackupOptions() {
  restoreOptions.value = {
    fields: [...Object.keys(restoreData.value?.manifest?.files ?? {})] as TBackupFields[],
    expandCookieMinutes: 0,
    keepExistUserInfo: true,
    // 每次解析出新备份都回到默认值（弹窗是复用实例，不能沿用上一次的勾选）
    restoreBackupServers: false,
  };
  currentStep.value = "restore";
}

/**
 * 如果是本地的文件，我们直接在 options 中解析，如果是服务器的文件，我们则在 offscreen 中解析
 */

const backupFile = shallowRef<File>();
function loadLocalBackupFile() {
  jsZipBlobToBackupData(backupFile.value as Blob, decryptKey.value)
    .then((data) => {
      restoreData.value = data;
      isDecryptKeyValid.value = true;
      buildBackupOptions();
    })
    .catch((err) => {
      console.error(err);
      restoreData.value = undefined;
      isDecryptKeyValid.value = false;
      runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.loadFailure", { error: err }), { color: "error" });
    });
}

/** a-upload 的 before-upload：只取文件并走原有解析逻辑，返回 false 阻止真正的上传 */
function beforeLoadLocalBackupFile(file: any) {
  backupFile.value = file as File;
  loadLocalBackupFile();
  return false;
}

const isLoadingRemoteBackupFile = ref<boolean>(false);
function loadRemoteBackupFile() {
  if (restoreMetadata.type === "remote") {
    isLoadingRemoteBackupFile.value = true;
    sendMessage("getRemoteBackupData", {
      backupServerId: restoreMetadata.server,
      path: restoreMetadata.path,
      decryptKey: decryptKey.value,
    })
      .then((data) => {
        restoreData.value = data;
        buildBackupOptions();
      })
      .catch((err) => {
        runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.loadFailure", { error: err }), { color: "error" });
        console.error(err);
        isDecryptKeyValid.value = false;
      })
      .finally(() => {
        isLoadingRemoteBackupFile.value = false;
      });
  }
}

/** 用 antd 的 Modal 替代原生浏览器版本确认框（异步等待用户选择） */
function confirmVersionWarning(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: t("SetBackup.RestoreDialog.versionWarning"),
      okText: t("common.dialog.ok"),
      cancelText: t("common.dialog.cancel"),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/**
 * S-1：把恢复结果如实告诉用户，而不是笼统地报「恢复成功」。
 * 报告结构（哪些字段被跳过 / 被安全化）来自 offscreen 侧，见 restoreSecurity.ts 的 summarizeRestoreResult。
 */
function reportRestoreResult(result: unknown) {
  const { success, notices } = summarizeRestoreResult(result);

  if (!success) {
    runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.partialFailure"), { color: "error" });
    return;
  }

  if (notices.length > 0) {
    runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.successWithNotice", { detail: notices.join("; ") }), {
      color: "warning",
    });
    return;
  }

  runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.success"), { color: "success" });
}

const isDoingRestore = ref<boolean>(false);
async function doRestore() {
  isDoingRestore.value = true;

  // 检查 version 字段
  if (!restoreData.value?.manifest?.version) {
    runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.missingVersion"), { color: "error" });
    isDoingRestore.value = false;
    return;
  }

  const warnRestore = compareVersion(restoreData.value.manifest.version, __EXT_VERSION__) == 1;
  if (!warnRestore || (await confirmVersionWarning())) {
    sendMessage("restoreBackupData", { restoreData: restoreData.value!, restoreOptions: restoreOptions.value })
      .then((result) => {
        reportRestoreResult(result);
        showDialog.value = false;
      })
      .catch((err) => {
        runtimeStore.showSnakebar(t("SetBackup.RestoreDialog.failure", { error: err }), { color: "error" });
        console.error(err);
      })
      .finally(() => {
        isDoingRestore.value = false;
      });
  } else {
    isDoingRestore.value = false;
  }
}

function convertIsoDurationToMinutes(duration: string): number {
  const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const match = duration.match(regex);

  if (!match) {
    throw new Error(`Invalid ISO 8601 duration format: ${duration}`);
  }

  const [, years, months, weeks, days, hours, minutes, seconds] = match;

  // 转换各时间单位为分钟
  const minutesFromYears = years ? parseInt(years, 10) * 365 * 24 * 60 : 0;
  const minutesFromMonths = months ? parseInt(months, 10) * 30 * 24 * 60 : 0; // 近似值，每月按30天计算
  const minutesFromWeeks = weeks ? parseInt(weeks, 10) * 7 * 24 * 60 : 0;
  const minutesFromDays = days ? parseInt(days, 10) * 24 * 60 : 0;
  const minutesFromHours = hours ? parseInt(hours, 10) * 60 : 0;
  const minutesFromMinutes = minutes ? parseInt(minutes, 10) : 0;
  const minutesFromSeconds = seconds ? parseInt(seconds, 10) / 60 : 0;

  // 计算总分钟数
  return (
    minutesFromYears +
    minutesFromMonths +
    minutesFromWeeks +
    minutesFromDays +
    minutesFromHours +
    minutesFromMinutes +
    minutesFromSeconds
  );
}

function resetDialog() {
  currentStep.value = restoreMetadata.type;
  decryptKey.value = configStore.backup.encryptionKey ?? "";

  restoreData.value = undefined;
  if (restoreMetadata.type === "file") {
    backupFile.value = undefined;
  } else if (restoreMetadata.type == "remote") {
    loadRemoteBackupFile();
  }
}

function goToPtppImport() {
  router.push({ name: "SetBaseBackup" });
  showDialog.value = false;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(resetDialog);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :keyboard="!isDoingRestore"
    :mask-closable="!isDoingRestore"
    :title="t('SetBackup.RestoreDialog.title')"
    :width="800"
  >
    <div class="ptd-inline-toolbar">
      <a-typography-text type="secondary">{{ t("SetBackup.RestoreDialog.ptppPrompt") }}</a-typography-text>
      <a-button size="small" type="primary" @click="goToPtppImport">
        <template #icon><UploadOutlined /></template>
        {{ t("SetBackup.RestoreDialog.ptppImport") }}
      </a-button>
    </div>

    <a-form layout="vertical">
      <div v-show="currentStep === 'file'">
        <a-upload
          accept="application/zip"
          :before-upload="beforeLoadLocalBackupFile"
          :file-list="[]"
          :max-count="1"
          :show-upload-list="true"
        >
          <a-button>
            <template #icon><UploadOutlined /></template>
            {{ t("SetBackup.RestoreDialog.selectFile") }}
          </a-button>
        </a-upload>
        <a-form-item :label="t('SetBackup.RestoreDialog.decryptKey')" style="margin-top: 8px">
          <a-input
            v-model:value="decryptKey"
            :placeholder="t('SetBackup.RestoreDialog.decryptKey')"
            :type="showDecryptKey ? 'text' : 'password'"
          >
            <template #suffix>
              <EyeOutlined v-if="showDecryptKey" style="cursor: pointer" @click="showDecryptKey = false" />
              <EyeInvisibleOutlined v-else style="cursor: pointer" @click="showDecryptKey = true" />
            </template>
          </a-input>
        </a-form-item>
        <a-button v-if="!isDecryptKeyValid" block :disabled="!backupFile" type="primary" @click="loadLocalBackupFile">
          <template #icon><SyncOutlined /></template>
          {{ t("SetBackup.RestoreDialog.retry") }}
        </a-button>
      </div>
      <div v-show="currentStep === 'remote'">
        <a-form-item :label="t('SetBackup.RestoreDialog.decryptKey')">
          <a-input
            v-model:value="decryptKey"
            :placeholder="t('SetBackup.RestoreDialog.decryptKey')"
            :type="showDecryptKey ? 'text' : 'password'"
          >
            <template #suffix>
              <EyeOutlined v-if="showDecryptKey" style="cursor: pointer" @click="showDecryptKey = false" />
              <EyeInvisibleOutlined v-else style="cursor: pointer" @click="showDecryptKey = true" />
            </template>
          </a-input>
        </a-form-item>
        <a-button
          v-if="!isDecryptKeyValid"
          block
          :loading="isLoadingRemoteBackupFile"
          type="primary"
          @click="loadRemoteBackupFile"
        >
          <template #icon><SyncOutlined /></template>
          {{ t("SetBackup.RestoreDialog.retry") }}
        </a-button>
        <!-- 远端备份数据加载中：用骨架屏占位；加载完成后仍无数据时给出空状态，避免内容区空白 -->
        <PageSkeleton v-if="isLoadingRemoteBackupFile" :rows="3" variant="card" />
        <NoDataPlaceholder v-else-if="currentStep === 'remote' && isEmpty(restoreData) && isDecryptKeyValid" />
      </div>
      <div v-show="currentStep === 'restore'">
        <!-- S-1：备份里可能含有他人植入的备份服务器配置与各类凭据 —— 恢复后自动备份会按备份中的
             backupFields 把本机凭据上传到那些服务器，因此这里必须让用户看见并显式决定，而不是静默恢复。 -->
        <a-alert
          v-if="restoreSecurity.showSecurityWarning || backupParseWarnings.length > 0"
          show-icon
          style="margin-bottom: 12px"
          type="warning"
        >
          <template #message>{{ t("SetBackup.RestoreDialog.securityWarning.title") }}</template>
          <template #description>
            <!-- 用 a-list 枚举要点：迁移验收（scripts/check-antd-migration.mjs 的 no-native-widgets）
                 禁止模板里出现原生 ul/ol/li；房内写法见 SetMediaServer/Editor.vue 的 a-list + a-list-item。 -->
            <a-list size="small">
              <a-list-item v-if="restoreSecurity.hasBackupServers">
                {{
                  t("SetBackup.RestoreDialog.securityWarning.backupServers", {
                    count: restoreSecurity.backupServers.length,
                  })
                }}
                <a-typography-text type="secondary">{{ restoreSecurity.backupServerLabels }}</a-typography-text>
              </a-list-item>
              <a-list-item v-if="restoreSecurity.sensitiveFields.length > 0">
                {{
                  t("SetBackup.RestoreDialog.securityWarning.sensitiveFields", {
                    fields: restoreSecurity.sensitiveFields.map((field) => t(`SetBackup.fields.${field}`)).join(", "),
                  })
                }}
              </a-list-item>
              <a-list-item v-if="backupParseWarnings.length > 0">
                {{ t("SetBackup.RestoreDialog.securityWarning.parseWarnings", { count: backupParseWarnings.length }) }}
                <a-typography-text type="secondary">{{ backupParseWarnings.join("; ") }}</a-typography-text>
              </a-list-item>
            </a-list>
          </template>
        </a-alert>

        <a-typography-text strong>{{ t("SetBackup.RestoreDialog.restoreOptions") }}</a-typography-text>
        <a-checkbox-group v-model:value="restoreOptions.fields" style="width: 100%">
          <a-row :gutter="[0, 8]">
            <a-col v-for="backupField in BackupFields" :key="backupField" :md="8" :xs="24">
              <a-checkbox :disabled="!restoreData?.manifest?.files?.[backupField]" :value="backupField">
                {{ t(`SetBackup.fields.${backupField}`) }}
              </a-checkbox>
            </a-col>
          </a-row>
        </a-checkbox-group>

        <a-form-item :label="t('SetBackup.RestoreDialog.expandCookieMinutes')" style="margin-top: 12px">
          <a-input-number
            v-model:value="restoreOptions.expandCookieMinutes"
            :disabled="!restoreOptions.fields?.includes('cookies')"
            :min="0"
            :step="1"
          />
          <template #extra>
            <a-space :size="4" wrap>
              <a-tag
                v-for="minutes in ['PT30M', 'PT1H', 'PT12H', 'P1D', 'P1W', 'P1M', 'P6M', 'P1Y']"
                :key="minutes"
                style="cursor: pointer"
                @click="() => (restoreOptions.expandCookieMinutes = convertIsoDurationToMinutes(minutes))"
              >
                {{ minutes }}
              </a-tag>
            </a-space>
          </template>
        </a-form-item>

        <a-checkbox v-model:checked="restoreOptions.keepExistUserInfo">
          {{ t("SetBackup.RestoreDialog.keepExistUserInfo") }}
        </a-checkbox>

        <!-- S-1：备份中的备份服务器配置默认不恢复，必须由用户显式勾选 -->
        <a-form-item v-if="restoreSecurity.hasBackupServers" style="margin-top: 12px">
          <a-checkbox v-model:checked="restoreOptions.restoreBackupServers">
            {{ t("SetBackup.RestoreDialog.restoreBackupServers", { count: restoreSecurity.backupServers.length }) }}
          </a-checkbox>
          <template #extra>
            <a-typography-text v-if="restoreSecurity.skippedBackupServerCount > 0" type="warning">
              {{
                t("SetBackup.RestoreDialog.willNotRestoreBackupServers", {
                  count: restoreSecurity.skippedBackupServerCount,
                })
              }}
            </a-typography-text>
          </template>
        </a-form-item>
      </div>
    </a-form>

    <template #footer>
      <a-flex align="center" justify="end" :gap="8">
        <!-- S-1：确认按钮旁明确写出「不会恢复备份服务器配置」的后果 -->
        <a-typography-text
          v-if="currentStep === 'restore' && restoreSecurity.skippedBackupServerCount > 0"
          type="warning"
        >
          {{
            t("SetBackup.RestoreDialog.willNotRestoreBackupServers", {
              count: restoreSecurity.skippedBackupServerCount,
            })
          }}
        </a-typography-text>
        <a-button :disabled="isDoingRestore" @click="showDialog = false">
          {{ t("common.dialog.cancel") }}
        </a-button>
        <a-button v-if="currentStep == 'restore'" @click="currentStep = restoreMetadata.type">
          {{ t("common.dialog.prev") }}
        </a-button>
        <a-button
          v-if="currentStep != 'restore'"
          :disabled="isEmpty(restoreData)"
          type="primary"
          @click="currentStep = 'restore'"
        >
          {{ t("common.dialog.next") }}
        </a-button>
        <a-button v-if="currentStep == 'restore'" :loading="isDoingRestore" type="primary" @click="doRestore">
          {{ t("common.dialog.ok") }}
        </a-button>
      </a-flex>
    </template>
  </a-modal>
</template>
