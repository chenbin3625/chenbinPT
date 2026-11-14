/**
 * SetSearchSolution/CustomSolutionDialog.vue：自定义搜索方案弹窗。
 *
 * 行为断言（真实挂载 + 真实 utils / metadata store）：
 * - 打开时按 selectCategory 生成方案：默认分类 → 重新生成 id、name 为空；
 *   非默认分类 → 用分类生成 name 并删除 selectedCategories；requestConfig 以 2 空格 JSON 预填；
 * - 名称为空 / requestConfig 非 JSON / 含 url|baseURL|headers 等不安全字段时禁用「确定」并显示错误；
 * - 合法输入点击「确定」调用 saveGeneratedSolution；绕过校验提交不安全配置时也不提交。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
// 标题里的站点名只是装饰，避免为未知站点解析完整定义
vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent: define, h: render } = await import("vue");
  return {
    default: define({ props: { siteId: String }, setup: (props) => () => render("span", props.siteId) }),
  };
});

/**
 * 纵深防御用例需要「表单校验通过、但提交时 sanitize 报告不安全字段」这一状态。
 * 正常 UI 下两者用同一份输入，无法构造；这里只在该用例里让 sanitize 临时报告 removedKeys，
 * 其余用例仍走真实实现。
 */
const sanitizeState = vi.hoisted(() => ({ forceUnsafe: false }));
vi.mock("@/options/views/Settings/SetSearchSolution/utils.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    sanitizeSearchEntryRequestConfig: (value: unknown) => {
      if (sanitizeState.forceUnsafe) return { requestConfig: undefined, removedKeys: ["url"] };
      return actual.sanitizeSearchEntryRequestConfig(value);
    },
  };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";

const t = i18nInstance.global.t;
const sleep = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const SITE_ID = "site-a";
const CATEGORY = {
  key: "categories",
  name: "Category",
  options: [
    { name: "Movies", value: 1 },
    { name: "TV", value: 2 },
  ],
};

let pinia: ReturnType<typeof prepareOptionsPinia>;
let metadataStore: ReturnType<typeof useMetadataStore>;
let Dialog: any;

beforeAll(async () => {
  pinia = prepareOptionsPinia();
  metadataStore = useMetadataStore(pinia);
  metadataStore.$save = vi.fn(async () => undefined);
  Dialog = (await import("@/options/views/Settings/SetSearchSolution/CustomSolutionDialog.vue")).default;
});

beforeEach(() => {
  document.body.innerHTML = "";
  metadataStore.sites = { [SITE_ID]: { merge: { category: [CATEGORY] } } } as any;
});

async function mountDialog(selectCategory: Record<string, unknown>) {
  const saveGeneratedSolution = vi.fn();
  const onUpdate = vi.fn();
  const open = ref(false);
  const dialogRef = ref<any>(null);

  // 用包装组件控制 v-model：组件只在 showDialog 由 false → true 时初始化，
  // 直接以 modelValue: true 挂载不会触发 watch（也就不会生成方案）。
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(Dialog as any, {
          ref: dialogRef,
          siteId: SITE_ID,
          selectCategory,
          saveGeneratedSolution,
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => {
            onUpdate(value);
            open.value = value;
          },
        }),
    }),
    { pinia },
  );

  open.value = true;
  await sleep(150);

  const nameInput = () => document.querySelector<HTMLInputElement>(".ant-modal input.ant-input")!;
  const textarea = () => document.querySelector<HTMLTextAreaElement>(".ant-modal textarea")!;
  const okButton = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;
  const modalText = () => document.querySelector<HTMLElement>(".ant-modal")?.textContent ?? "";

  async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
  }

  /** 弹窗是否仍处于打开状态（defineModel 的关闭表现为 update:modelValue(false)） */
  const isOpen = () => onUpdate.mock.calls.every(([value]) => value !== false);

  return {
    view,
    isOpen,
    dialogRef,
    saveGeneratedSolution,
    nameInput,
    textarea,
    okButton,
    modalText,
    setValue,
  };
}

describe("CustomSolutionDialog：打开时生成方案", () => {
  it("默认分类：重新生成 id（不再是 default），name 为空，requestConfig 预填空 params/data", async () => {
    const { view, isOpen, saveGeneratedSolution, nameInput, textarea, okButton, setValue } = await mountDialog({});
    try {
      expect(nameInput().value, "默认分类下 name 应为空").toBe("");
      expect(textarea().value).toBe(JSON.stringify({ params: {}, data: {} }, null, 2));
      expect(okButton().disabled, "名称为空时确定应禁用").toBe(true);

      // 补一个名称后提交，证明 id 已从 default 重新生成
      await setValue(nameInput(), "my plan");
      expect(okButton().disabled).toBe(false);
      okButton().click();
      await sleep(80);

      expect(saveGeneratedSolution).toHaveBeenCalledTimes(1);
      const solution = saveGeneratedSolution.mock.calls[0][0];
      expect(solution.id).not.toBe("default");
      expect(solution.id).toBeTruthy();
      expect(solution.name).toBe("my plan");
      expect(solution.searchEntries[solution.id].requestConfig).toEqual({ params: {}, data: {} });
      expect(isOpen(), "提交后应关闭弹窗").toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("非默认分类：用分类生成 name、删除 selectedCategories，requestConfig 按 2 空格 JSON 预填", async () => {
    const { view, nameInput, textarea, okButton } = await mountDialog({ categories: 1 });
    try {
      expect(nameInput().value).toBe("Category: Movies");
      expect(textarea().value).toBe(JSON.stringify({ params: { categories: 1 } }, null, 2));
      expect(okButton().disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("合法输入点击确定：调用 saveGeneratedSolution，写入的 requestConfig 只含 params/data", async () => {
    const { view, isOpen, saveGeneratedSolution, textarea, okButton, setValue } = await mountDialog({ categories: 1 });
    try {
      await setValue(textarea(), JSON.stringify({ params: { q: "1" }, data: { d: 1 } }, null, 2));
      expect(okButton().disabled).toBe(false);

      okButton().click();
      await sleep(80);

      expect(saveGeneratedSolution).toHaveBeenCalledTimes(1);
      const solution = saveGeneratedSolution.mock.calls[0][0];
      expect(solution.selectedCategories, "name 已包含分类信息，selectedCategories 应被删除").toBeUndefined();
      expect(solution.searchEntries[solution.id].requestConfig).toEqual({ params: { q: "1" }, data: { d: 1 } });
      expect(isOpen()).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe("CustomSolutionDialog：校验", () => {
  it("名称为空：确定禁用并显示必填错误", async () => {
    const { view, nameInput, okButton, modalText } = await mountDialog({});
    try {
      expect(nameInput().value).toBe("");
      expect(okButton().disabled).toBe(true);
      expect(modalText()).toContain(t("common.form.required"));
    } finally {
      view.unmount();
    }
  });

  it("requestConfig 不是合法 JSON：确定禁用并显示 JSON 错误", async () => {
    const { view, textarea, okButton, modalText, setValue } = await mountDialog({ categories: 1 });
    try {
      await setValue(textarea(), "{ not json");
      expect(okButton().disabled).toBe(true);
      expect(modalText()).toContain(t("SetSearchSolution.CustomSolutionDialog.requestConfigJsonError"));
    } finally {
      view.unmount();
    }
  });

  it("含 url / baseURL / headers 等不安全字段：确定禁用并显示不安全字段提示", async () => {
    const { view, textarea, okButton, modalText, setValue } = await mountDialog({ categories: 1 });
    try {
      await setValue(
        textarea(),
        JSON.stringify(
          {
            url: "https://attacker.example/collect",
            baseURL: "https://attacker.example",
            headers: { "x-api-key": "stolen" },
            params: { q: "1" },
          },
          null,
          2,
        ),
      );

      expect(okButton().disabled).toBe(true);
      const text = modalText();
      // 语言包已含 requestConfigUnsafeFields，tWithFallback 会走 t() 并插值字段名。
      expect(text).toContain(
        t("SetSearchSolution.CustomSolutionDialog.requestConfigUnsafeFields", {
          fields: "url, baseURL, headers",
        }),
      );
    } finally {
      view.unmount();
    }
  });
});

describe("CustomSolutionDialog：绕过校验也不提交不安全配置", () => {
  it("表单校验通过但 sanitize 报告不安全字段时，doSubmit 不调用 saveGeneratedSolution 且不关闭", async () => {
    const { view, isOpen, dialogRef, saveGeneratedSolution, textarea, setValue } = await mountDialog({ categories: 1 });
    try {
      // 合法 JSON（表单校验通过），但让 sanitize 报告有字段被剥离
      await setValue(textarea(), JSON.stringify({ params: { q: "1" } }, null, 2));
      sanitizeState.forceUnsafe = true;

      (dialogRef.value.$ as any).setupState.doSubmit();
      await sleep(60);

      expect(saveGeneratedSolution).not.toHaveBeenCalled();
      expect(isOpen(), "未提交时弹窗不应关闭").toBe(true);
    } finally {
      sanitizeState.forceUnsafe = false;
      view.unmount();
    }
  });

  it("requestConfig 不是合法 JSON 时直接调用 doSubmit 也不提交", async () => {
    const { view, dialogRef, saveGeneratedSolution, textarea, setValue } = await mountDialog({ categories: 1 });
    try {
      await setValue(textarea(), "{ not json");

      (dialogRef.value.$ as any).setupState.doSubmit();
      await sleep(60);

      expect(saveGeneratedSolution).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});
