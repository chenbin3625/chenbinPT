<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { computedAsync } from "@vueuse/core";
import { cloneDeep } from "es-toolkit";
import { EyeInvisibleOutlined, EyeOutlined, FilterOutlined } from "@ant-design/icons-vue";
import { getBackupServer, getBackupServerMetaData, IBackupMetadata } from "@ptd/backupServer";
import type { IBackupRetention } from "@ptd/backupServer";
import { DEFAULT_BACKUP_RETENTION_SAMPLE_RULES, hasBackupRetentionToApply } from "@ptd/backupServer/utils.ts";

import { BackupFields, type IBackupServerMetadata } from "@/shared/types.ts";
import { formValidateRules } from "@/options/utils.ts";

import ConnectCheckButton from "@/options/components/ConnectCheckButton.vue";

const { t } = useI18n();

const clientConfig = defineModel<IBackupServerMetadata>();
const emits = defineEmits<{
  (e: "update:configValid", value: boolean): void;
}>();

const hasRetention = computed(() => hasBackupRetentionToApply(clientConfig.value?.retention));

/**
 * B-31：备份服务器的凭据字段默认掩码显示，可逐个切换明文。
 *
 * 哪些字段是凭据由 `packages/backupServer` 的 requiredField 显式声明（`secret?: boolean`），
 * 不再按字段名猜测；未声明 secret 的字段保持历史行为（普通明文输入框）。
 */
const revealedConfigFields = ref<Set<string>>(new Set());

/** 该字段在 metaField 中被显式标记为凭据（密码 / 令牌 / 密钥） */
function isSecretConfigField(metaField: { secret?: boolean }): boolean {
  return metaField.secret === true;
}

/** 该字段当前是否以掩码显示 */
function isConfigFieldMasked(metaField: { secret?: boolean; key?: unknown }): boolean {
  // revealedConfigFields 是 ref：在 <script setup> 的普通函数体里不会自动解包（模板里才会）
  return isSecretConfigField(metaField) && !revealedConfigFields.value.has(String(metaField.key));
}

function toggleConfigFieldReveal(key: string) {
  const next = new Set(revealedConfigFields.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  revealedConfigFields.value = next;
}

/* -------------------------------------------------------------------------- */
/*                              备份保留策略（内联）                            */
/* -------------------------------------------------------------------------- */

/**
 * 备份保留策略的表单值。界面上始终展示一份完整的默认配置（避免用户勾选后出现空输入框），
 * 再从已保存的配置覆盖，因此这里持有一份本地副本而不是直接双向绑定到 clientConfig
 */
function createDefaultRetention(): IBackupRetention {
  return {
    time: { enabled: false, maxAge: 90 },
    count: { enabled: false, maxCount: 30 },
    sample: {
      enabled: false,
      rules: Object.fromEntries(
        Object.entries(DEFAULT_BACKUP_RETENTION_SAMPLE_RULES).map(([type, rule]) => [type, { ...rule }]),
      ),
    },
  };
}

const retentionDraft = ref<IBackupRetention>(createDefaultRetention());

/** 判断一份保留策略中是否真的有已启用的规则，没有则需要将其置空以保持一致 */
function hasEnabledRetentionRule(value: IBackupRetention): boolean {
  return !!(
    (value.time?.enabled && (value.time.maxAge ?? 0) > 0) ||
    (value.count?.enabled && (value.count.maxCount ?? 0) > 0) ||
    (value.sample?.enabled &&
      Object.values(value.sample.rules ?? {}).some((rule) => rule && rule.interval > 0 && rule.horizon > 0))
  );
}

const retentionSampleRows = computed(() =>
  Object.entries(retentionDraft.value.sample?.rules ?? {}).map(([type, rule]) => ({ key: type, type, rule })),
);

const retentionSampleColumns = computed(() => [
  { title: "", dataIndex: "type", key: "type", width: 110 },
  { title: t("SetBackup.RetentionDialog.sample.horizon"), dataIndex: "horizon", key: "horizon" },
  { title: t("SetBackup.RetentionDialog.sample.interval"), dataIndex: "interval", key: "interval" },
]);

/**
 * 把已保存的保留策略同步到本地草稿，使界面回显保存过的配置。
 *
 * 这里监听 `clientConfig.retention` 而不是只在挂载时初始化一次：
 * `EditDialog` 关闭后并不会销毁 Editor，再次编辑另一台服务器时需要跟着切换草稿。
 * 保存的配置可能是旧版本写入的、字段不全，因此以默认配置为基础再合并。
 *
 * 注意：本同步与下面的「草稿 → 配置」写入互为对方的输入，若不加标记会来回互相触发，
 * 因此用 `syncingFromConfig` 打断回环，并额外比较内容避免无意义的重复写入。
 */
let syncingFromConfig = false;
let lastSyncedRetention: string | undefined;

watch(
  () => clientConfig.value?.retention,
  (saved) => {
    syncingFromConfig = true;
    try {
      const draft = createDefaultRetention();

      retentionDraft.value = saved
        ? {
            time: { ...draft.time, ...saved.time },
            count: { ...draft.count, ...saved.count },
            sample: {
              ...draft.sample,
              ...saved.sample,
              rules: { ...draft.sample!.rules, ...saved.sample?.rules },
            },
          }
        : draft;

      lastSyncedRetention = JSON.stringify(retentionDraft.value);
    } finally {
      syncingFromConfig = false;
    }
  },
  { immediate: true },
);

watch(
  retentionDraft,
  (value) => {
    // 本次变化来自上面的「配置 → 草稿」同步，无需再写回配置
    if (syncingFromConfig || !clientConfig.value) {
      return;
    }

    // 未启用任何有效规则时置空，避免把一份「全未启用」的配置写入 metadata
    const nextRetention = hasEnabledRetentionRule(value) ? cloneDeep(value) : undefined;
    const nextSerialized = JSON.stringify(nextRetention ?? null);
    if (nextSerialized === lastSyncedRetention) {
      return; // 内容没有变化，避免重复写入触发无谓的持久化
    }

    lastSyncedRetention = nextSerialized;
    clientConfig.value.retention = nextRetention;
  },
  { deep: true },
);

/** 清空全部保留规则（对应「不自动清理历史备份」） */
function clearRetention() {
  retentionDraft.value = createDefaultRetention();
}

const retentionSummary = computed(() => {
  const retention = clientConfig.value?.retention;
  if (!hasBackupRetentionToApply(retention)) {
    return t("SetBackup.RetentionDialog.none");
  }

  const summary: string[] = [];
  if (retention?.time?.enabled && (retention.time.maxAge ?? 0) > 0) {
    summary.push(t("SetBackup.RetentionDialog.summary.time", { n: retention.time.maxAge }));
  }
  if (retention?.count?.enabled && (retention.count.maxCount ?? 0) > 0) {
    summary.push(t("SetBackup.RetentionDialog.summary.count", { n: retention.count.maxCount }));
  }
  if (retention?.sample?.enabled) {
    for (const [type, rule] of Object.entries(retention.sample.rules ?? {})) {
      if (rule && rule.interval > 0 && rule.horizon > 0) {
        summary.push(
          t("SetBackup.RetentionDialog.summary.sample", {
            type: t(`SetBackup.RetentionDialog.sample.type.${type}`),
            n: rule.horizon,
            interval: rule.interval,
          }),
        );
      }
    }
  }

  return summary.join(t("SetBackup.RetentionDialog.summary.separator"));
});

const clientMeta = computedAsync<IBackupMetadata<any>>(
  async () => {
    const clientType = clientConfig.value?.type;
    if (!clientType) {
      return { requiredField: [] } as IBackupMetadata<any>;
    }
    return await getBackupServerMetaData(clientType);
  },
  { requiredField: [] } as IBackupMetadata<any>,
);

const nameRules = [formValidateRules.require(t("SetBackup.Editor.nameTip"))];

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError(nameRules, clientConfig.value?.name));
// 与迁移前 PtdForm 广播的「表单是否合法」语义一致：任一字段的 rules 未通过即为不合法
const formValid = computed(() => !nameError.value);

async function checkConnect() {
  const clientType = clientConfig.value?.type;
  if (formValid.value && clientConfig.value && clientType) {
    const client = await getBackupServer(clientConfig.value);
    return await client.ping();
  }
  return false;
}
</script>

<template>
  <a-card style="margin-bottom: 20px">
    <a-form v-if="clientConfig" layout="vertical">
      <div>
        <a-typography-text strong style="display: block; margin: 8px 0">{{ t("common.basicInfo") }}</a-typography-text>
        <a-row :gutter="16">
          <a-col :md="8" :xs="24">
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
        </a-row>

        <a-typography-text strong style="display: block; margin: 8px 0">
          {{ t("SetBackup.Editor.serverConfig") }}
        </a-typography-text>

        <a-row :gutter="0">
          <a-col v-for="metaField in clientMeta.requiredField" :key="metaField.key" :span="24">
            <a-form-item :extra="metaField.description ?? undefined" :label="metaField.name">
              <a-textarea
                v-if="metaField.type === 'strings'"
                v-model:value="clientConfig.config[metaField.key! as string]"
                :rows="3"
              />
              <a-input
                v-else-if="metaField.type === 'string'"
                v-model:value="clientConfig.config[metaField.key! as string]"
                :type="isConfigFieldMasked(metaField) ? 'password' : 'text'"
              >
                <template v-if="isSecretConfigField(metaField)" #suffix>
                  <EyeOutlined
                    v-if="revealedConfigFields.has(metaField.key as string)"
                    style="cursor: pointer"
                    @click="toggleConfigFieldReveal(metaField.key as string)"
                  />
                  <EyeInvisibleOutlined
                    v-else
                    style="cursor: pointer"
                    @click="toggleConfigFieldReveal(metaField.key as string)"
                  />
                </template>
              </a-input>
              <a-switch
                v-else-if="metaField.type === 'boolean'"
                v-model:checked="clientConfig.config[metaField.key! as string]"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-divider style="margin: 8px 0" />

        <a-typography-text strong style="display: block; margin: 8px 0">
          {{ t("SetBackup.Editor.backupConfig") }}
        </a-typography-text>

        <!-- 以下三项为相互独立的备份设置，分别用子标题区分：备份内容 / 自动备份间隔 / 备份保留策略 -->
        <!-- 备份内容 -->
        <div>
          <a-typography-text strong type="secondary">{{ t("SetBackup.Editor.backupFields") }}</a-typography-text>
          <a-checkbox-group v-model:value="clientConfig.backupFields" style="width: 100%">
            <a-row :gutter="[0, 8]">
              <a-col v-for="backupField in BackupFields" :key="backupField" :md="8" :xs="24">
                <a-checkbox :value="backupField">{{ t(`SetBackup.fields.${backupField}`) }}</a-checkbox>
              </a-col>
            </a-row>
          </a-checkbox-group>
        </div>

        <a-divider style="margin: 12px 0" />

        <!-- 自动备份间隔 -->
        <div>
          <a-typography-text strong type="secondary">{{ t("SetBackup.Editor.backupInterval") }}</a-typography-text>
          <!-- 子标题已说明用途，此处标签仅表示单位，避免与子标题重复 -->
          <a-form-item
            :extra="t('SetBackup.Editor.backupIntervalHint')"
            :label="t('SetBackup.Editor.backupIntervalField')"
          >
            <a-input-number v-model:value="clientConfig.backupInterval" addon-after="h" :min="0" style="width: 100%" />
          </a-form-item>
        </div>

        <a-divider style="margin: 12px 0" />

        <!-- 备份保留策略：设置项直接内联展示，不再单独弹出对话框 -->
        <div>
          <a-flex align="center" :gap="8" wrap>
            <a-typography-text strong type="secondary">{{ t("SetBackup.Editor.retention") }}</a-typography-text>
            <!-- 仅在启用了保留策略时展示摘要，避免未启用时出现无意义的提示文字 -->
            <a-typography-text v-if="hasRetention" type="secondary">{{ retentionSummary }}</a-typography-text>
            <a-button
              v-if="hasRetention"
              danger
              :title="t('SetBackup.Editor.clearRetention')"
              type="text"
              @click="clearRetention"
            >
              <template #icon><FilterOutlined /></template>
            </a-button>
          </a-flex>

          <a-typography-text style="display: block" type="secondary">
            {{ t("SetBackup.RetentionDialog.tip") }}
          </a-typography-text>

          <div class="retention-group" style="padding: 16px">
            <!-- 按时间期限保留 -->
            <div class="retention-row">
              <a-switch v-model:checked="retentionDraft.time!.enabled" />
              <a-typography-text>{{ t("SetBackup.RetentionDialog.time.title") }}</a-typography-text>
              <div class="retention-field">
                <a-input-number
                  v-model:value="retentionDraft.time!.maxAge"
                  :addon-after="t('SetBackup.RetentionDialog.daySuffix')"
                  :disabled="!retentionDraft.time!.enabled"
                  :min="1"
                  style="width: 100%"
                />
              </div>
            </div>

            <a-divider style="margin: 8px 0" />

            <!-- 按数量保留 -->
            <div class="retention-row">
              <a-switch v-model:checked="retentionDraft.count!.enabled" />
              <a-typography-text>{{ t("SetBackup.RetentionDialog.count.title") }}</a-typography-text>
              <div class="retention-field">
                <a-input-number
                  v-model:value="retentionDraft.count!.maxCount"
                  :addon-after="t('SetBackup.RetentionDialog.countSuffix')"
                  :disabled="!retentionDraft.count!.enabled"
                  :min="1"
                  style="width: 100%"
                />
              </div>
            </div>

            <a-divider style="margin: 8px 0" />

            <!-- 按时间窗口采样保留 -->
            <div>
              <div class="retention-row">
                <a-switch v-model:checked="retentionDraft.sample!.enabled" />
                <a-typography-text>{{ t("SetBackup.RetentionDialog.sample.title") }}</a-typography-text>
              </div>
              <a-typography-text style="display: block" type="secondary">
                {{ t("SetBackup.RetentionDialog.sample.hint") }}
              </a-typography-text>

              <!-- 采样规则：窗口名称 / 保留窗口数 / 窗口宽度（天） -->
              <a-table
                :columns="retentionSampleColumns"
                :data-source="retentionSampleRows"
                :pagination="false"
                size="small"
                :style="{ opacity: retentionDraft.sample!.enabled ? 1 : 0.5 }"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'type'">
                    <span style="white-space: nowrap">
                      {{ t(`SetBackup.RetentionDialog.sample.type.${record.type}`) }}
                    </span>
                  </template>
                  <template v-else-if="column.key === 'horizon'">
                    <a-input-number
                      v-model:value="record.rule.horizon"
                      :disabled="!retentionDraft.sample!.enabled"
                      :min="0"
                    />
                  </template>
                  <template v-else-if="column.key === 'interval'">
                    <a-input-number
                      v-model:value="record.rule.interval"
                      :addon-after="t('SetBackup.RetentionDialog.daySuffix')"
                      :disabled="!retentionDraft.sample!.enabled"
                      :min="0"
                    />
                  </template>
                </template>
              </a-table>
            </div>
          </div>
        </div>

        <ConnectCheckButton
          :check-fn="checkConnect"
          :reset-timeout="3e3"
          @after:check-connect="
            () => emits('update:configValid', formValid && true) // 不管是否测试成功，都允许用户进行下一步操作（保存下载服务器配置）
          "
        />
      </div>
    </a-form>
  </a-card>
</template>
