<script setup lang="ts">
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";
import { computedAsync } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { type IDownloaderMetadata } from "@/shared/types.ts";

import { getDownloader, getDownloaderMetaData, TorrentClientMetaData } from "@ptd/downloader";
import { formatDate, formValidateRules, isInsecureAddress } from "@/options/utils.ts";

import ConnectCheckButton from "@/options/components/ConnectCheckButton.vue";

const { t } = useI18n();

const clientConfig = defineModel<IDownloaderMetadata>();
const emits = defineEmits<{
  (e: "update:configValid", value: boolean): void;
}>();
const clientMeta = computedAsync<TorrentClientMetaData>(
  // clientConfig 在编辑对话框 after-enter 时才赋值，computedAsync 首次求值可能尚未就绪，需空值短路
  async () =>
    clientConfig.value?.type ? await getDownloaderMetaData(clientConfig.value.type) : ({} as TorrentClientMetaData),
  {} as TorrentClientMetaData,
);

const showPassword = ref<boolean>(false);

const nameRules = [formValidateRules.require(t("SetDownloader.editor.nameTip"))];
const addressRules = [formValidateRules.url(t("SetDownloader.editor.addressTip"))];
// F2-Low-07：`formValidateRules.require` 用 `!!v` 判断，排序号 0 会被判成「未填写」。
// 排序号是数字字段，这里改为只拒绝 null / undefined / 空串（0 合法）。
const sortIndexRequiredRule = (v: unknown): boolean | string =>
  (typeof v === "number" && Number.isFinite(v)) ||
  (v !== undefined && v !== null && v !== "") ||
  t("common.form.required");
const sortIndexRules = [sortIndexRequiredRule];

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError(nameRules, clientConfig.value?.name));
const addressError = computed(() => firstError(addressRules, clientConfig.value?.address));
const sortIndexError = computed(() => firstError(sortIndexRules, clientConfig.value?.sortIndex));

// 与迁移前 PtdForm 广播的「表单是否合法」语义一致：任一字段的 rules 未通过即为不合法
const formValid = computed(() => !nameError.value && !addressError.value && !sortIndexError.value);

// F2-Medium-03 / Low-04：表单有效性必须**持续**驱动「确定」按钮，而不是只在「测试连接」后刷新一次。
// 旧实现只在 `@after:check-connect` 里 emit（且表达式 `formValid && true` 恒真），
// 于是点过一次测试连接后，清空名称/地址仍然可以保存。
watch(
  formValid,
  (valid) => {
    emits("update:configValid", valid);
  },
  { immediate: true },
);

// 兼容「恢复备份 / 旧版本导入」得到的下载器配置：那类配置可能没有 feature 字段，
// 而模板里的 v-model:checked="clientConfig.feature!.X" 需要该对象存在，否则渲染期抛 TypeError。
watch(
  clientConfig,
  (config) => {
    if (config && !config.feature) config.feature = {};
  },
  { immediate: true, deep: false },
);

async function checkConnect() {
  if (formValid.value) {
    const client = await getDownloader(clientConfig.value!);
    return await client.ping();
  }
  return false;
}
</script>

<template>
  <a-card style="margin-bottom: 20px">
    <a-form v-if="clientConfig" layout="vertical">
      <div>
        <a-row :gutter="16">
          <a-col :md="4" :xs="24">
            <a-form-item :label="t('common.type')">
              <a-input v-model:value="clientConfig.type" disabled />
            </a-form-item>
          </a-col>
          <a-col :md="8" :xs="24">
            <a-form-item :help="nameError" :label="t('SetDownloader.common.name')" required>
              <a-input
                v-model:value="clientConfig.name"
                :placeholder="t('SetDownloader.common.name')"
                :status="nameError ? 'error' : undefined"
              />
            </a-form-item>
          </a-col>
          <a-col :md="8" :xs="24">
            <a-form-item :label="t('SetDownloader.common.uid') + t('SetDownloader.editor.uidPlaceholder')">
              <a-input v-model:value="clientConfig.id" disabled />
            </a-form-item>
          </a-col>
          <a-col :md="4" :xs="24">
            <a-form-item :help="sortIndexError" :label="t('common.sortIndex')">
              <a-input-number
                v-model:value="clientConfig.sortIndex"
                :status="sortIndexError ? 'error' : undefined"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row>
          <a-col :span="24">
            <a-form-item :help="addressError" :label="t('SetDownloader.common.address')" required>
              <a-input v-model:value="clientConfig.address" :status="addressError ? 'error' : undefined" />
            </a-form-item>
            <!-- M-10：http:// / ws:// 地址下密码与 token 会明文传输，明确提示而不是静默拦截 -->
            <a-alert
              v-if="isInsecureAddress(clientConfig.address)"
              :message="t('common.insecureAddressWarning')"
              show-icon
              style="margin-bottom: 16px"
              type="warning"
            />
          </a-col>
        </a-row>
        <a-row v-if="typeof clientConfig.username !== 'undefined'">
          <a-col :span="24">
            <a-form-item :label="t('common.username')">
              <a-input v-model:value="clientConfig.username" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row>
          <a-col :span="24">
            <a-form-item :label="t('SetDownloader.editor.password')" style="padding-right: 20px">
              <a-input v-model:value="clientConfig.password" :type="showPassword ? 'text' : 'password'">
                <template #suffix>
                  <EyeOutlined v-if="showPassword" style="cursor: pointer" @click="showPassword = false" />
                  <EyeInvisibleOutlined v-else style="cursor: pointer" @click="showPassword = true" />
                </template>
              </a-input>
            </a-form-item>
          </a-col>
        </a-row>
        <a-row>
          <a-col :span="24">
            <a-form-item :label="t('SetDownloader.editor.timeout')" style="padding-inline: 8px">
              <a-flex align="center" :gap="8">
                <a-slider
                  v-model:value="clientConfig.timeout"
                  :max="10 * 60e3"
                  :min="0"
                  :step="1e3"
                  style="flex: 1 1 auto"
                />
                <a-button type="text" @click="clientConfig.timeout = 60e3">
                  {{ formatDate(clientConfig.timeout!, "mm:ss") }}
                </a-button>
              </a-flex>
            </a-form-item>
          </a-col>
        </a-row>
        <a-row>
          <a-col v-if="clientMeta?.feature?.DefaultAutoStart?.allowed" :span="24">
            <a-form-item style="margin-left: 16px">
              <a-flex align="center" :gap="8">
                <a-switch v-model:checked="clientConfig.feature!.DefaultAutoStart" />
                <a-typography-text>{{ t("SetDownloader.editor.autoStart") }}</a-typography-text>
              </a-flex>
            </a-form-item>
          </a-col>
        </a-row>
        <!-- 连接行为开关（非种子添加参数），按 clientMeta.feature.BypassCSRF 声明显式开启（目前仅 qBittorrent） -->
        <a-row>
          <a-col v-if="clientMeta?.feature?.BypassCSRF?.allowed" :span="24">
            <a-form-item :help="t('SetDownloader.editor.bypassCSRFHelp')" style="margin-left: 16px">
              <a-flex align="center" :gap="8">
                <a-switch v-model:checked="clientConfig.feature!.BypassCSRF" />
                <a-typography-text>{{ t("SetDownloader.editor.bypassCSRF") }}</a-typography-text>
              </a-flex>
            </a-form-item>
          </a-col>
        </a-row>

        <a-row v-if="clientMeta.advanceAddTorrentOptions">
          <a-col>
            <a-collapse>
              <a-collapse-panel key="advanced" :header="t('common.advancedSettings')">
                <a-form-item v-for="opt in clientMeta.advanceAddTorrentOptions" :key="opt.key" :help="opt.description">
                  <a-flex align="center" :gap="8">
                    <a-switch v-model:checked="clientConfig.advanceAddTorrentOptions![opt.key]" />
                    <a-typography-text>{{ opt.name }}</a-typography-text>
                  </a-flex>
                </a-form-item>
              </a-collapse-panel>
            </a-collapse>
          </a-col>
        </a-row>
      </div>

      <!-- 「测试连接」只负责连通性提示；保存门禁由上面的 formValid 持续驱动 -->
      <ConnectCheckButton :check-fn="checkConnect" :reset-timeout="3e3" />

      <a-alert v-if="clientMeta?.warning" show-icon type="warning">
        <template #message>
          <a-list size="small">
            <a-list-item v-for="data in clientMeta.warning" :key="data">● {{ data }}</a-list-item>
          </a-list>
        </template>
      </a-alert>
    </a-form>
  </a-card>
</template>
