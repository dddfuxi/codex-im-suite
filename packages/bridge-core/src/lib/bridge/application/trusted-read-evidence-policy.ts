/**
 * 统一裁决“已经由受控本地 Host 读出的事实”是否应锁定为无工具回复。
 *
 * 这不是按某个业务名词（如喝水、打卡）做特例：只要当前回合是纯读取，且
 * Runtime 已经返回可供展示的可信快照，Provider 就不应再用工作区、CLI 或
 * 外部连接器寻找第二个来源来覆盖该快照。写入/执行意图不能走这里，仍由各自
 * 的后置 Host 与权限链执行。
 */
export interface TrustedLocalReadEvidenceBoundary {
  /** 当前 Runtime Host 是否实际返回了可供回答的受控 evidence。 */
  available: boolean;
  /** 当前用户意图是否严格为只读；混合写入或执行必须为 false。 */
  readOnly: boolean;
}

export function requiresResponseOnlyForTrustedLocalReadEvidence(
  boundaries: readonly TrustedLocalReadEvidenceBoundary[],
): boolean {
  return boundaries.some((boundary) => boundary.available && boundary.readOnly);
}
