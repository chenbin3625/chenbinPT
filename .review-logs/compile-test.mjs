import { parse, compileTemplate } from "@vue/compiler-sfc";
const cases = [
  `<a-modal @after-open-change="f" @update:open="g" @ok="h" />`,
  `<a-input @press-enter="f" @update:value="g" @change="h" />`,
  `<a-select @update:value="f" @search="h" />`,
  `<a-switch @update:checked="f" />`,
  `<a-tabs @update:active-key="f" @change="h" />`,
  `<a-table @update:expanded-row-keys="f" @change="h" />`,
  `<Editor @update:form-valid="f" @update:configValid="g" />`,
];
for (const src of cases) {
  const { descriptor } = parse(`<template>${src}</template>`);
  const r = compileTemplate({ source: descriptor.template.content, id: "x", filename: "x.vue" });
  const m = r.code.match(/createVNode\([^,]+,\s*\{([\s\S]*?)\}\s*[,)]/);
  console.log(src);
  console.log("   ->", (m?.[1] ?? r.code).replace(/\s+/g, " ").slice(0, 300), "\n");
}
