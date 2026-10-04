<script setup lang="ts">
import type { ISearchSolution } from "@/shared/types.ts";

import SolutionDetail from "@/options/components/SolutionDetail.vue";
import SiteName from "@/options/components/SiteName.vue";

const {
  solutions,
  closable = true,
  column = false,
} = defineProps<{
  solutions: ISearchSolution[];
  closable?: boolean;
  /** 竖直排列（原 PtdChipGroup 的 `column`），用于侧栏/窄容器 */
  column?: boolean;
}>();

const emit = defineEmits(["remove:solution"]);

function removeSolution(solution: ISearchSolution) {
  emit("remove:solution", solution);
}
</script>

<template>
  <div style="padding-top: 4px">
    <a-space :direction="column ? 'vertical' : 'horizontal'" :size="4" wrap>
      <a-tag
        v-for="solution in solutions"
        :key="solution.id"
        :closable="closable"
        style="height: auto; padding: 2px 8px"
        @close="() => removeSolution(solution)"
      >
        <SiteName class="" :site-id="solution.siteId" tag="span" />&nbsp;->&nbsp;
        <SolutionDetail :solution="solution" />
      </a-tag>
    </a-space>
  </div>
</template>
