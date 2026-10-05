<script setup lang="ts">
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";
import { computedAsync } from "@vueuse/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getMediaServer, getMediaServerMetaData, IMediaServerMetadata } from "@ptd/mediaServer";

import type { IMediaServerMetadata as IMediaServerConfig } from "@/shared/types.ts";
import { formatDate, formValidateRules, isInsecureAddress } from "@/options/utils.ts";

import ConnectCheckButton from "@/options/components/ConnectCheckButton.vue";

const { t } = useI18n();

const clientConfig = defineModel<IMediaServerConfig>();
const emits = defineEmits<{
  (e: "update:configValid", value: boolean): void;
}>();

const clientMeta = computedAsync<IMediaServerMetadata>(
  // clientConfig 在编辑对话框 after-enter 时才赋值，computedAsync 首次求值可能尚未就绪，需空值短路
  async () =>
    clientConfig.value?.type ? await getMediaServerMetaData(clientConfig.value.type) : ({} as IMediaServerMetadata),
  {} as IMediaServerMetadata,
);

// V-9：原先复用 `SetDownloader.editor.*` 的文案，于是媒体服务器对话框会显示
// 「为这个**下载服务器**取个好记的名字」——术语与场景都不对。已补 `SetMediaServer.Editor.*` 专属文案。
const nameRules = [formValidateRules.require(t("SetMediaServer.Editor.nameTip"))];
const addressRules = [formValidateRules.url(t("SetMediaServer.Editor.addressTip"))];

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError(nameRules, clientConfig.value?.name));
const addressError = computed(() => firstError(addressRules, clientConfig.value?.address));

function authFieldName(authField: string | { name: string }) {
  return typeof authField === "string" ? authField : authField.name;
}

// B-31：媒体服务器凭据（fnOS 的 password、emby/jellyfin/plex 的 apikey ...）默认掩码显示，
// 与 SetDownloader/Editor.vue 的密码框保持一致，可按字段切换明文。
const revealedAuthFields = ref<Set<string>>(new Set());
const SECRET_AUTH_FIELD_PATTERN = /passw|passwd|password|pwd|apikey|api[_-]?key|token|cookie|secret/i;

function isSecretAuthField(authField: string | { name: string }): boolean {
  return SECRET_AUTH_FIELD_PATTERN.test(authFieldName(authField));
}

/** 该字段当前是否以掩码显示 */
function isAuthFieldMasked(authField: string | { name: string }): boolean {
  // revealedAuthFields 是 ref：在 <script setup> 的普通函数体里不会自动解包（模板里才会）
  return isSecretAuthField(authField) && !revealedAuthFields.value.has(authFieldName(authField));
}

function toggleAuthFieldReveal(authField: string | { name: string }) {
  const name = authFieldName(authField);
  const next = new Set(revealedAuthFields.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  revealedAuthFields.value = next;
}

function authFieldRules(authField: string | { name: string; required?: boolean }) {
  return typeof authField === "string" || authField.required ? [formValidateRules.require()] : [];
}

function authFieldError(authField: string | { name: string; required?: boolean }) {
  const name = authFieldName(authField);
  return firstError(authFieldRules(authField), clientConfig.value?.auth?.[name]);
}

// 与迁移前 PtdForm 广播的「表单是否合法」语义一致：任一字段的 rules 未通过即为不合法
const formValid = computed(() => {
  if (nameError.value || addressError.value) return false;
  return (clientMeta.value?.auth_field ?? []).every((authField) => !authFieldError(authField));
});

async function checkConnect() {
  if (formValid) {
    const client = await getMediaServer(clientConfig.value!);
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
        <a-row>
          <a-col :span="24">
            <a-form-item :help="addressError" :label="t('SetDownloader.common.address')" required>
              <a-input v-model:value="clientConfig.address" :status="addressError ? 'error' : undefined" />
            </a-form-item>
            <!-- M-10：http:// 地址下 apikey / password 会明文传输，明确提示而不是静默拦截 -->
            <a-alert
              v-if="isInsecureAddress(clientConfig.address)"
              :message="t('common.insecureAddressWarning')"
              show-icon
              style="margin-bottom: 16px"
              type="warning"
            />
          </a-col>
        </a-row>

        <a-row>
          <a-col style="padding-block: 0" :span="24">
            <a-typography-text strong>{{ t("SetMediaServer.Editor.authInfo") }}</a-typography-text>
          </a-col>
          <a-col v-for="authField in clientMeta!.auth_field" :key="authFieldName(authField)" :span="24">
            <a-form-item
              v-if="typeof authField === 'string'"
              :help="authFieldError(authField)"
              :label="authField"
              required
            >
              <a-input
                v-model:value="clientConfig.auth[authField]"
                :status="authFieldError(authField) ? 'error' : undefined"
                :type="isAuthFieldMasked(authField) ? 'password' : 'text'"
              >
                <template v-if="isSecretAuthField(authField)" #suffix>
                  <EyeOutlined
                    v-if="revealedAuthFields.has(authField)"
                    style="cursor: pointer"
                    @click="toggleAuthFieldReveal(authField)"
                  />
                  <EyeInvisibleOutlined v-else style="cursor: pointer" @click="toggleAuthFieldReveal(authField)" />
                </template>
              </a-input>
            </a-form-item>
            <a-form-item v-else :help="authField.message ?? authFieldError(authField)" :label="authField.name" required>
              <a-input
                v-model:value="clientConfig.auth[authField.name]"
                :status="authFieldError(authField) ? 'error' : undefined"
                :type="isAuthFieldMasked(authField) ? 'password' : 'text'"
              >
                <template v-if="isSecretAuthField(authField)" #suffix>
                  <EyeOutlined
                    v-if="revealedAuthFields.has(authField.name)"
                    style="cursor: pointer"
                    @click="toggleAuthFieldReveal(authField)"
                  />
                  <EyeInvisibleOutlined v-else style="cursor: pointer" @click="toggleAuthFieldReveal(authField)" />
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
      </div>
    </a-form>
  </a-card>
</template>
