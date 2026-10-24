/**
 * 触发浏览器下载（替代 `file-saver` 的 `saveAs`）。
 *
 * 只在扩展页面（options）里使用：目标浏览器（Chrome 140+ / Firefox 133+）都支持 `<a download>`，
 * 不需要 file-saver 为旧浏览器准备的 FileReader / 弹窗兜底。
 *
 * - `Blob`：生成 object URL，下载触发后延迟释放（与 file-saver 一样等 40s，避免大文件还没开始写盘就被回收）；
 * - `string`：视为已有的 URL（例如 Konva 导出的 data URL），直接交给 `<a download>`。
 */
const REVOKE_DELAY = 40_000;

export function saveAs(data: Blob | string, filename: string): void {
  const href = typeof data === "string" ? data : URL.createObjectURL(data);

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  // Firefox 要求 <a> 在文档中才会响应 click()
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  if (typeof data !== "string") {
    setTimeout(() => URL.revokeObjectURL(href), REVOKE_DELAY);
  }
}
