// 此处放置一些全局都可以用的助手函数、常量定义

// 仓库相关
export const REPO_NAME = "chenbin3625/chenbinPT";
export const REPO_URL = `https://github.com/${REPO_NAME}`;
export const REPO_API = `https://api.github.com/repos/${REPO_NAME}`;

// 环境相关
export const isProd = import.meta.env.PROD;
export const isDebug = !isProd;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
