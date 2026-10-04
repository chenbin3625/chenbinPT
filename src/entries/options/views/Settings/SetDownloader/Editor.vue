<script setup lang="ts">
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";
import { computedAsync } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { type IDownloaderMetadata } from "@/shared/types.ts";

import { getDownloader, getDownloaderMetaData, TorrentClientMetaData } from "@ptd/downloader";
import { formatDate, formValidateRules } from "@/options/utils.ts";

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
const sortIndexRules = [formValidateRules.require()];

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
  if (formValid) {
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
            <a-form-item
              help="移除请求的 Origin 头以绕过 qBittorrent 的跨站请求伪造(CSRF)校验，开启后无需在 qBittorrent 中关闭 CSRF 保护"
              style="margin-left: 16px"
            >
              <a-flex align="center" :gap="8">
                <a-switch v-model:checked="clientConfig.feature!.BypassCSRF" />
                <a-typography-text>绕过 CSRF 保护</a-typography-text>
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

      <ConnectCheckButton
        :check-fn="checkConnect"
        :reset-timeout="3e3"
        @after:check-connect="
          () => emits('update:configValid', formValid && true) // 不管是否测试成功，都允许用户进行下一步操作（保存下载服务器配置）
        "
      />

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
