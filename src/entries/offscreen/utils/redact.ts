/**
 * URL 脱敏工具（见审查报告 L-7 / OS-1 / A4）。
 *
 * 实现已迁移到 `src/entries/shared/redact.ts`（background 的原生桥接也要复用同一套规则，
 * 见复检报告 M1）。这里保留原路径 re-export，避免 offscreen 内既有 import（logger /
 * downloadHistorySanitize / 测试）全部改动；新代码请直接 import `@/shared/redact.ts`。
 */
export * from "@/shared/redact.ts";
