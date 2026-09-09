import { useState } from "react";
import type {
  AutoDirectorAction,
  AutoDirectorFollowUpDetail,
  AutoDirectorFollowUpItem,
} from "@ai-novel/shared/types/autoDirectorFollowUp";
import { Button } from "@/components/ui/button";
import {
  TaskQueueActionRow,
  TaskQueueImpactNotice,
  TaskQueueSection,
  TaskQueueStatusBadge,
} from "@/components/taskQueue";
import { WorkspaceStateNotice } from "@/components/workspace";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";
import {
  getFollowUpActionConsequence,
  getFollowUpActionRiskDescription,
  getFollowUpActionTone,
  getFollowUpLevelLabel,
  getFollowUpPriorityLabel,
  getFollowUpSeverity,
  getFollowUpTone,
} from "../followUpPresentation";

interface AutoDirectorFollowUpDetailPanelProps {
  detail: AutoDirectorFollowUpDetail | null;
  selectedItem: AutoDirectorFollowUpItem | null;
  loading: boolean;
  errorMessage?: string | null;
  actionLoading: boolean;
  managementLoading?: boolean;
  globalModel?: { provider?: string; model?: string; temperature?: number } | null;
  onExecuteAction: (
    item: AutoDirectorFollowUpItem,
    action: AutoDirectorAction,
    llmOverride?: { provider?: string; model?: string; temperature?: number } | null,
  ) => void | Promise<void>;
  onRefreshValidation: () => void | Promise<void>;
  onSafeFix: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onArchive?: (item: AutoDirectorFollowUpItem) => void | Promise<void>;
  onDelete?: (item: AutoDirectorFollowUpItem) => void | Promise<void>;
}

function supportsModelOverride(actionCode: string): boolean {
  return actionCode === "continue_auto_execution"
    || actionCode === "continue_generic"
    || actionCode === "retry_with_task_model"
    || actionCode === "retry_with_route_model";
}

export function AutoDirectorFollowUpDetailPanel({
  detail,
  selectedItem,
  loading,
  errorMessage,
  actionLoading,
  managementLoading = false,
  globalModel = null,
  onExecuteAction,
  onRefreshValidation,
  onSafeFix,
  onRetry,
  onArchive,
  onDelete,
}: AutoDirectorFollowUpDetailPanelProps) {
  const [useGlobalModel, setUseGlobalModel] = useState(true);
  const globalModelLabel = globalModel?.provider || globalModel?.model
    ? `${globalModel?.provider ?? "未指定渠道"} / ${globalModel?.model ?? "未指定模型"}`
    : null;
  const globalModelAvailable = Boolean(globalModel?.provider && globalModel?.model);
  const buildOverrideForAction = (action: AutoDirectorAction) => {
    if (!useGlobalModel || !globalModelAvailable || !supportsModelOverride(action.code)) {
      return null;
    }
    return {
      provider: globalModel?.provider,
      model: globalModel?.model,
      temperature: globalModel?.temperature,
    };
  };
  const deliveryStatusLabels = {
    delivered: "已送达",
    pending: "投递中",
    failed: "投递失败",
  } as const;
  const eventTypeLabels = {
    "auto_director.approval_required": "需要处理",
    "auto_director.auto_approved": "AI 已自动通过",
    "auto_director.exception": "任务异常",
    "auto_director.recovered": "已恢复",
    "auto_director.completed": "已完成",
    "auto_director.progress_changed": "进度变化",
  } as const;
  const tone = selectedItem ? getFollowUpTone(selectedItem) : "neutral";

  return (
    <TaskQueueSection
      title="跟进详情"
      description="每个动作都会说明后果；跟进项会保持对应的导演任务身份，不与手动工作区任务混用。"
      className="min-w-0 overflow-hidden"
    >
      <div className="space-y-4">
        {loading ? (
          <WorkspaceStateNotice loading title="正在读取跟进详情" description="正在同步导演任务、检查点和最近校验结果。" />
        ) : null}

        {errorMessage ? (
          <WorkspaceStateNotice
            tone="danger"
            title="跟进详情读取失败"
            description={errorMessage}
            action={<Button size="sm" variant="outline" onClick={() => void onRetry()}>重新读取</Button>}
          />
        ) : null}

        {!loading && !errorMessage && (!detail || !selectedItem) ? (
          <WorkspaceStateNotice title="请选择一个导演跟进项" description="选择后可查看阻塞范围、下一步和安全动作。" />
        ) : null}

        {detail && selectedItem ? (
          <>
            <div className="space-y-1">
              <div className={`${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText} font-medium`}>{selectedItem.novelTitle}</div>
              <div className={`${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText} text-sm text-muted-foreground`}>{selectedItem.reasonLabel}</div>
              <div className="flex flex-wrap gap-2 pt-2">
                <TaskQueueStatusBadge label={getFollowUpLevelLabel(selectedItem)} tone={tone} />
                <TaskQueueStatusBadge label={getFollowUpPriorityLabel(selectedItem.priority, selectedItem.reason)} tone={tone} />
              </div>
            </div>

            <TaskQueueImpactNotice
              severity={getFollowUpSeverity(selectedItem)}
              title={getFollowUpLevelLabel(selectedItem)}
              description={detail.blockingReason ?? detail.followUpSummary}
            />

            {detail.riskNote ? (
              <WorkspaceStateNotice
                compact
                tone={tone === "danger" ? "danger" : tone === "warning" ? "warning" : "info"}
                title="风险说明"
                description={detail.riskNote}
              />
            ) : null}

            <div className={`grid gap-2 text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
              <div>下一步建议：{detail.nextStepSuggestion ?? "查看任务详情后再继续。"}</div>
              <div>检查点摘要：{detail.checkpointSummary ?? "暂无"}</div>
              <div>当前模型：{detail.currentModel ?? "暂无"}</div>
            </div>

            {selectedItem.section === "needs_validation" ? (
              <div className={`space-y-3 rounded-md border border-warning/25 bg-warning/5 p-3 text-sm text-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-medium">先校验任务和资产状态</div>
                    <div className="mt-1 text-xs">
                      安全修复只处理状态对账，不会清除正文、重写规划、确认候选、切换模型或替你做创作选择。
                    </div>
                  </div>
                </div>
                {(detail.validationSummary?.blockingReasons.length ?? 0) > 0 ? (
                  <div className="space-y-1 text-xs">
                    {detail.validationSummary?.blockingReasons.map((reason) => (
                      <div key={reason}>阻塞：{reason}</div>
                    ))}
                  </div>
                ) : null}
                {(detail.validationSummary?.warnings.length ?? 0) > 0 ? (
                  <div className="space-y-1 text-xs">
                    {detail.validationSummary?.warnings.map((warning) => (
                      <div key={warning}>提示：{warning}</div>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction}
                    disabled={actionLoading}
                    onClick={() => void onRefreshValidation()}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    一键重新校验
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={actionLoading}
                    className={`${AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction} border-warning/40 bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning`}
                    title="仅修复校验标记为低风险的状态、检查点、进度、恢复目标、自动执行对账、替代原因、审计和通知记录；不会清除正文、重写资产、重规划、确认候选、切换模型或生成内容。"
                    onClick={() => void onSafeFix()}
                  >
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    一键安全修复
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="text-sm font-medium">可执行动作</div>
              {globalModelAvailable ? (
                <label className={`flex cursor-pointer items-start gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={useGlobalModel}
                    onChange={(event) => setUseGlobalModel(event.target.checked)}
                  />
                  <span>
                    使用当前全局模型继续或重试（{globalModelLabel ?? "未选择模型"}）。勾选后，继续与重试会先把任务模型切换到全局模型，适合原接口到限时换路继续。
                  </span>
                </label>
              ) : null}
              {detail.availableActions.map((action) => (
                <TaskQueueActionRow
                  key={action.code}
                  title={action.kind === "mutation" && supportsModelOverride(action.code) && useGlobalModel && globalModelAvailable
                    ? `${action.label}（用全局模型）`
                    : action.label}
                  consequence={`${getFollowUpActionConsequence(action)} 风险：${getFollowUpActionRiskDescription(action)}`}
                  tone={getFollowUpActionTone(action)}
                  action={(
                    <Button
                      variant={action.kind === "mutation" && action.riskLevel === "low" ? "default" : "outline"}
                      size="sm"
                      className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction}
                      disabled={actionLoading}
                      onClick={() => void onExecuteAction(selectedItem, action, buildOverrideForAction(action))}
                    >
                      {action.label}
                    </Button>
                  )}
                />
              ))}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">清理测试任务</div>
              <div className="text-xs text-muted-foreground">收起只隐藏跟进列表，彻底删除会清除导演任务与运行记录；小说与章节正文保留。</div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction}
                  disabled={actionLoading || managementLoading || !onArchive}
                  onClick={() => void onArchive?.(selectedItem)}
                >
                  收起这条跟进
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction}
                  disabled={actionLoading || managementLoading || !onDelete}
                  onClick={() => void onDelete?.(selectedItem)}
                >
                  彻底删除任务
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">最近里程碑</div>
              <div className="space-y-2">
                {detail.milestones.length === 0 ? (
                  <div className="text-sm text-muted-foreground">暂无里程碑</div>
                ) : detail.milestones.map((milestone) => (
                  <div key={`${milestone.at}:${milestone.label}`} className={`rounded-md border p-3 text-sm ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                    <div className="font-medium">{milestone.label}</div>
                    <div className="text-xs text-muted-foreground">{new Date(milestone.at).toLocaleString()}</div>
                    {milestone.summary ? (
                      <div className="mt-1 text-xs text-muted-foreground">{milestone.summary}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">通道触达</div>
              <div className="space-y-2">
                {(detail.channelDeliveries?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">暂无通道投递记录</div>
                ) : detail.channelDeliveries?.map((delivery) => (
                  <div key={`${delivery.channelType}:${delivery.eventType}`} className={`rounded-md border p-3 text-sm ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <TaskQueueStatusBadge label={delivery.channelType === "dingtalk" ? "钉钉" : "企微"} tone="neutral" />
                      <TaskQueueStatusBadge
                        label={deliveryStatusLabels[delivery.status]}
                        tone={delivery.status === "delivered" ? "success" : delivery.status === "failed" ? "danger" : "info"}
                      />
                      <span className="text-xs text-muted-foreground">{eventTypeLabels[delivery.eventType]}</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      目标：{delivery.target ?? "未记录"} | 响应码：{delivery.responseStatus ?? "未记录"} | 时间：{delivery.deliveredAt ? new Date(delivery.deliveredAt).toLocaleString() : "未送达"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </TaskQueueSection>
  );
}
