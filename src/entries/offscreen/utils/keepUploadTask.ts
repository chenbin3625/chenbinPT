/**
 * 辅种任务处理函数
 *
 * 性能说明（见 docs/performance-audit.md P0-3）：辅种任务以单 key 存储整张表，
 * 早期实现的增删改都是「整表读取 → 改一条 → 整表写回」，任务多时写入量 O(N²)。
 * 现改为按任务 id 做局部读写（写入在 service worker 内串行完成）。
 */

import { onMessage, sendMessage } from "@/messages.ts";
import type { IKeepUploadTask, TKeepUploadTaskKey, TKeepUploadTaskStorageSchema } from "@/shared/types.ts";

const STORAGE_KEY = "keepUploadTask" as const;

/**
 * 获取所有辅种任务
 */
export async function getKeepUploadTasks(): Promise<IKeepUploadTask[]> {
  const tasks = (await sendMessage("getExtStoragePath", {
    key: STORAGE_KEY,
    path: [],
    defaultValue: {},
  })) as TKeepUploadTaskStorageSchema;
  return tasks ? Object.values(tasks) : [];
}

onMessage("getKeepUploadTasks", getKeepUploadTasks);

/**
 * 根据ID获取辅种任务
 */
export async function getKeepUploadTaskById(taskId: TKeepUploadTaskKey): Promise<IKeepUploadTask | undefined> {
  return (await sendMessage("getExtStoragePath", {
    key: STORAGE_KEY,
    path: [taskId],
    defaultValue: undefined,
  })) as IKeepUploadTask | undefined;
}

onMessage("getKeepUploadTaskById", async ({ data: taskId }) => {
  const task = await getKeepUploadTaskById(taskId);
  return task!;
});

/**
 * 创建辅种任务
 */
export async function createKeepUploadTask(task: IKeepUploadTask): Promise<void> {
  await sendMessage("patchExtStoragePath", {
    key: STORAGE_KEY,
    path: [task.id],
    value: task,
  });
}

onMessage("createKeepUploadTask", async ({ data: task }) => {
  await createKeepUploadTask(task);
});

/**
 * 更新辅种任务（保持原语义：任务不存在时不写入）
 */
export async function updateKeepUploadTask(task: IKeepUploadTask): Promise<void> {
  const existed = await getKeepUploadTaskById(task.id);
  if (existed) {
    await sendMessage("patchExtStoragePath", {
      key: STORAGE_KEY,
      path: [task.id],
      value: task,
    });
  }
}

onMessage("updateKeepUploadTask", async ({ data: task }) => {
  await updateKeepUploadTask(task);
});

/**
 * 删除辅种任务
 */
export async function deleteKeepUploadTask(taskId: TKeepUploadTaskKey): Promise<void> {
  await sendMessage("patchExtStoragePath", {
    key: STORAGE_KEY,
    path: [taskId],
    remove: true,
  });
}

onMessage("deleteKeepUploadTask", async ({ data: taskId }) => {
  await deleteKeepUploadTask(taskId);
});

/**
 * 清空所有辅种任务
 */
export async function clearKeepUploadTasks(): Promise<void> {
  await sendMessage("setExtStorage", { key: STORAGE_KEY, value: {} });
}

onMessage("clearKeepUploadTasks", clearKeepUploadTasks);

/**
 * 生成唯一ID
 */
export function generateKeepUploadTaskId(): TKeepUploadTaskKey {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
