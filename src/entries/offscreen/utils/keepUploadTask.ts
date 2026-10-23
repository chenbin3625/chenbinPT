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
 * B1-6：把「读存在 → 写」串成链，修复 TOCTOU。
 *
 * `updateKeepUploadTask` 先 `getKeepUploadTaskById` 再 `patchExtStoragePath`，两次跨上下文往返之间
 * 任务的删除可能已经完成（`deleteKeepUploadTask` / `clearKeepUploadTasks`），于是更新会把已删除的
 * 任务整条写回（「保持原语义：任务不存在时不写入」失效）。
 *
 * 所有会改这张表的操作（create/update/delete/clear）都在同一上下文（offscreen）里，按一条链串行即可
 * 让「检查 + 写入」与删除互斥；读取不参与串行（读到中间态由调用方自己处理）。
 */
let keepUploadTaskMutationChain: Promise<unknown> = Promise.resolve();
function enqueueKeepUploadTaskMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = keepUploadTaskMutationChain.then(task, task);
  keepUploadTaskMutationChain = next.catch(() => undefined);
  return next;
}

/**
 * 创建辅种任务
 */
export async function createKeepUploadTask(task: IKeepUploadTask): Promise<void> {
  await enqueueKeepUploadTaskMutation(async () => {
    await sendMessage("patchExtStoragePath", {
      key: STORAGE_KEY,
      path: [task.id],
      value: task,
    });
  });
}

onMessage("createKeepUploadTask", async ({ data: task }) => {
  await createKeepUploadTask(task);
});

/**
 * 更新辅种任务（保持原语义：任务不存在时不写入）
 */
export async function updateKeepUploadTask(task: IKeepUploadTask): Promise<void> {
  await enqueueKeepUploadTaskMutation(async () => {
    const existed = await getKeepUploadTaskById(task.id);
    if (!existed) {
      return;
    }
    await sendMessage("patchExtStoragePath", {
      key: STORAGE_KEY,
      path: [task.id],
      value: task,
    });
  });
}

onMessage("updateKeepUploadTask", async ({ data: task }) => {
  await updateKeepUploadTask(task);
});

/**
 * 删除辅种任务
 */
export async function deleteKeepUploadTask(taskId: TKeepUploadTaskKey): Promise<void> {
  await enqueueKeepUploadTaskMutation(async () => {
    await sendMessage("patchExtStoragePath", {
      key: STORAGE_KEY,
      path: [taskId],
      remove: true,
    });
  });
}

onMessage("deleteKeepUploadTask", async ({ data: taskId }) => {
  await deleteKeepUploadTask(taskId);
});

/**
 * 整表替换辅种任务（备份恢复等场景）。
 *
 * B1-6 续：`offscreen/utils/backup.ts` 恢复备份时对 `keepUploadTask` 字段走的是
 * `sendMessage("setExtStorage", { key, value })` 整表覆盖，**不经过本模块的串行链**；
 * 若此时正好有 `updateKeepUploadTask` 的「读存在 → 写」在途，二者仍可能互相覆盖
 * （更新把已恢复/已删除的任务写回，或恢复把更新的任务整表抹掉）。
 *
 * 这里提供与 create/update/delete 同一条链的整表替换入口，恢复流程应改用它：
 *   `await replaceKeepUploadTasks(backupFieldValue)`。
 * 注意：`backup.ts` 的接线不在本任务 write scope 内（task-11 / Lead 负责），本模块先就绪。
 */
export async function replaceKeepUploadTasks(tasks: TKeepUploadTaskStorageSchema): Promise<void> {
  await enqueueKeepUploadTaskMutation(async () => {
    await sendMessage("setExtStorage", { key: STORAGE_KEY, value: tasks });
  });
}

/**
 * 清空所有辅种任务
 */
export async function clearKeepUploadTasks(): Promise<void> {
  await replaceKeepUploadTasks({});
}

onMessage("clearKeepUploadTasks", clearKeepUploadTasks);

/**
 * 生成唯一ID
 */
export function generateKeepUploadTaskId(): TKeepUploadTaskKey {
  // 优先用强随机（offscreen 有 crypto）；不可用时回落到旧实现。
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 11);
  return `${Date.now()}-${suffix}`;
}
