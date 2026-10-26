<script setup lang="ts">
import { StarOutlined } from "@ant-design/icons-vue";
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ITorrent } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { getTorrentFavoriteKey, normalizeFavCategories, type ITorrentFavoriteStatus } from "@/shared/types.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatSize } from "@/options/utils.ts";

/**
 * 收藏 / 编辑收藏对话框（ #708 ）。
 *
 * 同时用于 options（搜索结果、收藏列表）与内容脚本（站点列表页 / 详情页）。为此只通过
 * `getTorrentFavoriteStatus` 读取「这些种子」的收藏状态（不含链接），而不是读取整份收藏表：
 * 内容脚本无权读取整表（其中各站点的下载链接可能内嵌 passkey）。
 */
const showDialog = defineModel<boolean>();

const { torrentItems } = defineProps<{
  torrentItems: ITorrent[];
}>();

const emits = defineEmits<{
  (e: "saved"): void;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const favCategories = ref<string[]>([]); // 收藏分类（用户自设，类似文件夹，同一种子可入多个）
const comment = ref<string>(""); // 备注
const status = shallowRef<ITorrentFavoriteStatus>({ favorites: [], favCategories: [] });
const saving = ref(false);

const favCategoryOptions = computed(() =>
  status.value.favCategories.map((category) => ({ label: category, value: category })),
);
const favoriteMap = computed(() => new Map(status.value.favorites.map((x) => [x.key, x])));
const favoritedItems = computed(() =>
  torrentItems.filter((item) => favoriteMap.value.has(getTorrentFavoriteKey(item))),
);

/** 选中的种子全部已收藏时视为「编辑收藏」：回填其分类与备注，避免直接覆盖成空值 */
const isEdit = computed(() => torrentItems.length > 0 && favoritedItems.value.length === torrentItems.length);

const totalSize = computed(() => torrentItems.reduce((acc, item) => acc + (item.size ?? 0), 0));

function isFavorited(torrent: ITorrent) {
  return favoriteMap.value.has(getTorrentFavoriteKey(torrent));
}

/** 只把查询需要的字段发出去（消息里不必携带整份种子） */
function toStatusQuery(torrents: ITorrent[]) {
  return torrents.map(({ site, id, link, url }) => ({ site, id, link, url }));
}

watch(
  showDialog,
  async (show) => {
    if (!show) {
      return;
    }

    status.value = { favorites: [], favCategories: [] };
    favCategories.value = [];
    comment.value = "";

    try {
      status.value = await sendMessage("getTorrentFavoriteStatus", { torrents: toStatusQuery(torrentItems) });
    } catch {
      // 读取失败时按「尚未收藏」处理：对话框仍可保存（保存失败会单独提示），本组件不新增 console（no-console 门禁）
      status.value = { favorites: [], favCategories: [] };
    }

    // 回填第一个种子的收藏信息（新建收藏时通常为空）
    const exist = torrentItems.length > 0 ? favoriteMap.value.get(getTorrentFavoriteKey(torrentItems[0]!)) : undefined;
    favCategories.value = [...(exist?.favCategories ?? [])];
    comment.value = exist?.comment ?? "";
  },
  // 调用方可能按需挂载（v-if 与 v-model 同时为 true），挂载时就要加载一次
  { immediate: true },
);

/**
 * 成功提示按「新增 / 更新」区分：编辑已有收藏时不能再说「已收藏」，否则会被误认为重复收藏了一次
 */
function successMessage(count: number) {
  const updated = favoritedItems.value.length;
  const added = count - updated;

  if (updated === 0) {
    return t("MyCollection.dialog.saveSuccess", [added]);
  }
  if (added === 0) {
    return t("MyCollection.dialog.editSuccess", [updated]);
  }
  return t("MyCollection.dialog.saveAndEditSuccess", [added, updated]);
}

async function save() {
  saving.value = true;
  try {
    // 传入空数组 / 空字符串表示清空该项，缺省才表示保持原值；此处始终以输入框中的内容为准
    const count = await sendMessage("createTorrentFavorites", {
      torrents: torrentItems,
      favCategories: normalizeFavCategories(favCategories.value),
      comment: comment.value.trim(),
    });
    runtimeStore.showSnakebar(successMessage(count), { color: "success" });
    emits("saved");
    showDialog.value = false;
  } catch (e) {
    runtimeStore.showSnakebar(t("MyCollection.dialog.saveError"), { color: "error" });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :closable="!saving"
    :keyboard="!saving"
    :mask-closable="!saving"
    :title="isEdit ? t('MyCollection.dialog.editTitle') : t('MyCollection.dialog.title', [torrentItems.length])"
    :width="760"
  >
    <a-form layout="vertical">
      <a-form-item :extra="t('MyCollection.dialog.favCategoriesHint')" :label="t('MyCollection.dialog.favCategories')">
        <a-select
          v-model:value="favCategories"
          :options="favCategoryOptions"
          allow-clear
          mode="tags"
          :token-separators="[',', '，']"
        />
      </a-form-item>
      <a-form-item :label="t('MyCollection.dialog.comment')">
        <a-textarea v-model:value="comment" :auto-size="{ minRows: 2, maxRows: 6 }" allow-clear />
      </a-form-item>
    </a-form>

    <a-alert
      v-if="favoritedItems.length > 0 && !isEdit"
      :message="t('MyCollection.dialog.alreadyFavoritedNotice', [favoritedItems.length])"
      show-icon
      style="margin-bottom: 8px"
      type="warning"
    />

    <a-list :data-source="torrentItems" size="small" style="max-height: 240px; overflow-y: auto">
      <template #renderItem="{ item }">
        <a-list-item>
          <a-list-item-meta :description="formatSize(item.size ?? 0)">
            <template #title>
              <span class="ptd-cell-ellipsis" style="max-width: 36rem" :title="item.title">{{ item.title }}</span>
            </template>
          </a-list-item-meta>
          <a-tag v-if="isFavorited(item)" color="gold">{{ t("MyCollection.dialog.alreadyFavorited") }}</a-tag>
        </a-list-item>
      </template>
    </a-list>

    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-typography-text type="secondary">
          {{ t("MyCollection.dialog.totalSize", [formatSize(totalSize)]) }}
        </a-typography-text>
        <a-space>
          <a-button :disabled="saving" @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
          <a-button :loading="saving" type="primary" @click="save">
            <template #icon><StarOutlined /></template>
            {{ t("common.dialog.ok") }}
          </a-button>
        </a-space>
      </a-flex>
    </template>
  </a-modal>
</template>
