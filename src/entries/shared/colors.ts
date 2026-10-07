/**
 * 站点定义（src/packages/site）与历史代码中使用 Material 调色板名称（如 "blue-grey-darken-2"）表示颜色，
 * 迁移到 antd 后统一通过该方法转换为可直接用于 style / a-tag color 的色值。
 * 语义色（primary/success/...）映射为 antd 默认主题的对应色值。
 */

const semanticColors: Record<string, string> = {
  primary: "#1677ff",
  secondary: "#8c8c8c",
  success: "#52c41a",
  info: "#1677ff",
  warning: "#faad14",
  error: "#ff4d4f",
};

// Material Design 2 调色板（主色 500 + 常用的 lighten/darken 档位）
const palette: Record<string, Record<string, string>> = {
  red: {
    base: "#f44336",
    "lighten-1": "#ef5350",
    "lighten-2": "#e57373",
    "darken-1": "#e53935",
    "darken-2": "#d32f2f",
    "darken-4": "#b71c1c",
  },
  pink: { base: "#e91e63", "darken-2": "#c2185b" },
  purple: { base: "#9c27b0", "darken-2": "#7b1fa2" },
  "deep-purple": { base: "#673ab7" },
  indigo: { base: "#3f51b5" },
  blue: {
    base: "#2196f3",
    "lighten-1": "#42a5f5",
    "darken-1": "#1e88e5",
    "darken-2": "#1976d2",
    "darken-4": "#0d47a1",
  },
  "light-blue": { base: "#03a9f4" },
  cyan: { base: "#00bcd4", "lighten-2": "#4dd0e1", "darken-2": "#0097a7" },
  teal: { base: "#009688" },
  green: { base: "#4caf50", "darken-2": "#388e3c", "darken-4": "#1b5e20" },
  "light-green": { base: "#8bc34a" },
  lime: { base: "#cddc39" },
  yellow: { base: "#ffeb3b", "darken-2": "#fbc02d", "darken-4": "#f57f17" },
  amber: { base: "#ffc107", "darken-2": "#ffa000" },
  orange: { base: "#ff9800", "darken-3": "#ef6c00", "darken-4": "#e65100" },
  "deep-orange": { base: "#ff5722" },
  brown: { base: "#795548" },
  grey: { base: "#9e9e9e", "lighten-2": "#e0e0e0", "lighten-4": "#f5f5f5", "darken-1": "#757575" },
  "blue-grey": { base: "#607d8b", "darken-1": "#546e7a", "darken-2": "#455a64" },
};

export function resolveColor(color?: string | null): string | undefined {
  if (!color) return undefined;
  if (color.startsWith("#") || color.startsWith("rgb") || color.startsWith("hsl") || color.startsWith("var(")) {
    return color;
  }
  // BACKGROUNDSHARED-5：两张表都是对象字面量，普通下标会沿原型链命中
  // （resolveColor("constructor") 会返回 Object 构造函数、"__proto__" 返回 Object.prototype），
  // 调用点的 `?? "default"` 兜不住真值，于是标签底色退化成无效样式。查表统一改用 Object.hasOwn。
  if (Object.hasOwn(semanticColors, color)) return semanticColors[color];

  const name = color === "gray" ? "grey" : color;
  const match = name.match(/^(.+?)-((?:lighten|darken|accent)-\d)$/);
  if (match && Object.hasOwn(palette, match[1])) {
    return palette[match[1]][match[2]] ?? palette[match[1]].base;
  }
  if (Object.hasOwn(palette, name)) return palette[name].base;

  // 其他 CSS 颜色关键字（black/transparent/gold/turquoise 等）直接透传
  return name;
}
