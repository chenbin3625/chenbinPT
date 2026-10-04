<script setup lang="ts">
import { ApiOutlined, CheckCircleFilled, CloseCircleOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";

import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";
import type { BridgeState, BridgeStatus } from "@/shared/types.ts";

const { t } = useI18n();

const extensionId = chrome.runtime.id;

function detectBrowserFamily(): string {
  if (__BROWSER__ === "firefox") return "firefox";
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Chromium/")) return "chromium";
  return "chrome";
}

const browserFamily = detectBrowserFamily();
const setupCommand = computed(() => {
  if (browserFamily === "firefox") {
    return "ptd install --browser firefox";
  }
  return `ptd install --browser ${browserFamily} --extension-id ${extensionId}`;
});

const status = shallowRef<BridgeStatus>({
  permissionGranted: false,
  enabled: true,
  state: "no-permission",
  connected: false,
});

const loading = ref(false);
const testLoading = ref(false);
const permissionLoading = ref(false);
// 首屏状态是异步读回来的，读到之前 status 还是默认值（未授权 / no-permission），
// 直接渲染会让用户先看到一个错误的状态，因此用它驱动两张卡片的骨架
const initialLoading = ref(true);

async function refreshStatus() {
  try {
    status.value = await sendMessage("nativeBridgeGetStatus", undefined);
  } catch (e: any) {
    console.debug("[PTD] Failed to get bridge status:", e);
  }
}

async function grantPermission() {
  permissionLoading.value = true;
  try {
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (granted) {
      await refreshStatus();
    } else {
      console.debug("[PTD]", t("SetNativeBridge.permission.grantFailed"));
    }
  } catch (e: any) {
    console.debug("[PTD] Permission request error:", e);
  } finally {
    permissionLoading.value = false;
  }
}

async function revokePermission() {
  permissionLoading.value = true;
  try {
    await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    await refreshStatus();
  } catch (e: any) {
    console.debug("[PTD] Permission revoke error:", e);
  } finally {
    permissionLoading.value = false;
  }
}

async function toggleEnabled(newValue: boolean) {
  loading.value = true;
  try {
    status.value = await sendMessage("nativeBridgeSetEnabled", newValue);
  } catch (e: any) {
    console.debug("[PTD] Failed to set enabled:", e);
  } finally {
    loading.value = false;
  }
}

async function waitForSettledState(maxMs = 5000, intervalMs = 500) {
  const transientStates: BridgeState[] = ["connecting", "retrying"];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await refreshStatus();
    if (!transientStates.includes(status.value.state)) {
      return;
    }
  }
}

async function testConnection() {
  testLoading.value = true;
  try {
    status.value = await sendMessage("nativeBridgeReconnect", undefined);
    if (status.value.state === "connecting") {
      await waitForSettledState();
    }
  } catch (e: any) {
    console.debug("[PTD] Reconnect failed:", e);
  } finally {
    testLoading.value = false;
  }
}

const stateColor: Record<BridgeState, string> = {
  "no-permission": "grey",
  disabled: "grey",
  connecting: "orange",
  connected: "green",
  retrying: "orange",
  error: "red",
};

onMounted(async () => {
  try {
    await refreshStatus();
  } finally {
    initialLoading.value = false;
  }
});
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <!-- Permission Section -->
      <a-typography-text strong style="display: block; margin: 8px 0">
        {{ t("SetNativeBridge.permission.title") }}
      </a-typography-text>
      <a-card :bordered="false" :loading="initialLoading" style="margin-bottom: 16px; padding: 16px">
        <div class="ptd-settings-row">
          <a-tag :color="status.permissionGranted ? resolveColor('green') : resolveColor('grey')">
            <CheckCircleFilled v-if="status.permissionGranted" style="margin-right: 4px" />
            <CloseCircleOutlined v-else style="margin-right: 4px" />
            {{
              status.permissionGranted
                ? t("SetNativeBridge.permission.granted")
                : t("SetNativeBridge.permission.notGranted")
            }}
          </a-tag>

          <a-button
            v-if="!status.permissionGranted"
            :loading="permissionLoading"
            size="small"
            type="primary"
            @click="grantPermission"
          >
            {{ t("SetNativeBridge.permission.grant") }}
          </a-button>
          <a-button v-else :loading="permissionLoading" size="small" type="text" @click="revokePermission">
            {{ t("SetNativeBridge.permission.revoke") }}
          </a-button>
        </div>
      </a-card>

      <!-- Bridge Control Section -->
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin: 8px 0">
        {{ t("SetNativeBridge.bridge.title") }}
      </a-typography-text>
      <a-card :bordered="false" :loading="initialLoading" style="margin-bottom: 16px; padding: 16px">
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetNativeBridge.bridge.enabled") }}</a-typography-text>
          <a-switch
            :checked="status.enabled"
            :disabled="!status.permissionGranted"
            :loading="loading"
            @update:checked="toggleEnabled"
          />
        </div>

        <div class="ptd-settings-row">
          <a-tag :color="resolveColor(stateColor[status.state])">
            {{ t(`SetNativeBridge.bridge.status.${status.state}`) }}
          </a-tag>

          <a-button
            :disabled="!status.permissionGranted || !status.enabled"
            :loading="testLoading"
            size="small"
            type="link"
            @click="testConnection"
          >
            <template #icon>
              <ApiOutlined />
            </template>
            {{ t("SetNativeBridge.bridge.testConnection") }}
          </a-button>
        </div>

        <a-alert v-if="status.lastError" :message="status.lastError" show-icon style="margin-top: 12px" type="error" />

        <a-alert
          v-if="
            status.permissionGranted && status.enabled && status.state !== 'connected' && status.state !== 'connecting'
          "
          show-icon
          style="margin-top: 16px"
          type="warning"
        >
          <template #message>
            {{ t("SetNativeBridge.info.setupCommand") }}
            <code
              style="display: block; margin: 8px 0; padding: 8px; background: var(--ptd-hover); border-radius: 4px"
              >{{ setupCommand }}</code
            >
            {{ t("SetNativeBridge.info.setupHint") }}
          </template>
        </a-alert>
      </a-card>
    </section>

    <section class="ptd-settings-section">
      <!-- Info Section -->
      <a-typography-text strong style="display: block; margin: 8px 0">
        {{ t("SetNativeBridge.info.title") }}
      </a-typography-text>
      <a-typography-paragraph class="ptd-section-description">
        {{ t("SetNativeBridge.info.description") }}
        <br /><br />
        <i18n-t keypath="SetNativeBridge.info.cliRequired" tag="strong">
          <a-typography-link href="https://github.com/chenbin3625/ptd-cli" rel="noopener" target="_blank">
            {{ t("SetNativeBridge.info.cliLink") }}
          </a-typography-link>
        </i18n-t>
      </a-typography-paragraph>
      <a-alert :message="t('SetNativeBridge.info.privacy')" show-icon style="margin-top: 16px" type="warning" />
    </section>
  </div>
</template>
