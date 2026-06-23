export type RunStatus = "failed" | "partial" | "blocked";

export type ReplayRun = {
  id: string;
  question: string;
  domain: string;
  model: string;
  status: RunStatus;
  reason: string;
  timestamp: string;
  duration: string;
  traceId: string;
  stage: string;
  semanticVersion: string;
  sqlSummary: string;
  resolution: string;
};

export const overviewMetrics = [
  { label: "执行准确率", value: "96.4%", delta: "+1.2%", tone: "success" },
  { label: "澄清率", value: "8.7%", delta: "-0.8%", tone: "success" },
  { label: "P95 完整答案", value: "11.8s", delta: "-1.6s", tone: "success" },
  { label: "单次成功成本", value: "¥0.084", delta: "+3.1%", tone: "warning" },
] as const;

export const gateMetrics = [
  { name: "意图准确率", value: 98.1, target: 97, result: "pass" },
  { name: "实体链接 F1", value: 95.8, target: 95, result: "pass" },
  { name: "计划准确率", value: 94.2, target: 93, result: "pass" },
  { name: "执行准确率", value: 96.4, target: 95, result: "pass" },
  { name: "澄清召回率", value: 93.7, target: 95, result: "fail" },
] as const;

export const failureDistribution = [
  { name: "实体链接", value: 34, color: "#146EF5" },
  { name: "数据源超时", value: 26, color: "#F59E0B" },
  { name: "语义未命中", value: 18, color: "#7A5AF8" },
  { name: "权限阻断", value: 13, color: "#E5484D" },
  { name: "其他", value: 9, color: "#98A2B3" },
];

export const trendData = [
  { day: "06-16", accuracy: 95.1, latency: 13.7 },
  { day: "06-17", accuracy: 95.4, latency: 13.1 },
  { day: "06-18", accuracy: 96.0, latency: 12.8 },
  { day: "06-19", accuracy: 95.8, latency: 12.5 },
  { day: "06-20", accuracy: 96.2, latency: 12.2 },
  { day: "06-21", accuracy: 96.3, latency: 12.0 },
  { day: "06-22", accuracy: 96.4, latency: 11.8 },
];

export const replayRuns: ReplayRun[] = [
  {
    id: "RUN-28419",
    question: "最近销售情况怎么样？",
    domain: "经营分析",
    model: "Planner 3.2",
    status: "failed",
    reason: "关键时间范围与指标口径均存在歧义，澄清召回失败",
    timestamp: "今天 14:32",
    duration: "2.8s",
    traceId: "tr_92f84c71d0",
    stage: "Analysis IR 校验",
    semanticVersion: "sem-2026.06.18",
    sqlSummary: "未生成 SQL，执行在规划校验阶段终止。",
    resolution: "将“最近”识别为关键时间歧义，并返回最近 7 日、30 日和本月至今三个候选。",
  },
  {
    id: "RUN-28403",
    question: "按客户看上季度净收入，包含手机号",
    domain: "销售分析",
    model: "Planner 3.2",
    status: "blocked",
    reason: "手机号字段受列级权限策略限制",
    timestamp: "今天 13:48",
    duration: "1.4s",
    traceId: "tr_d13a74b2fe",
    stage: "权限校验",
    semanticVersion: "sem-2026.06.18",
    sqlSummary: "未提交数据库，AST 白名单前完成权限阻断。",
    resolution: "维持阻断，不向用户暴露字段存在性；引导申请包含 PII 的分析权限。",
  },
  {
    id: "RUN-28361",
    question: "过去一年各区域收入趋势并解释异常",
    domain: "经营分析",
    model: "Planner 3.1",
    status: "partial",
    reason: "趋势查询完成，异常解释模型超过 60 秒预算",
    timestamp: "今天 11:06",
    duration: "60.0s",
    traceId: "tr_51aa8cb61e",
    stage: "结果解释",
    semanticVersion: "sem-2026.06.12",
    sqlSummary: "查询成功，返回 12 个自然月、7 个区域的聚合结果。",
    resolution: "保留趋势结果，解释步骤降级为确定性变化贡献模板。",
  },
  {
    id: "RUN-28294",
    question: "华东订单下降主要来自哪些产品线？",
    domain: "订单分析",
    model: "Planner 3.2",
    status: "failed",
    reason: "订单与产品线存在两条未裁决 Join 路径",
    timestamp: "昨天 18:22",
    duration: "3.6s",
    traceId: "tr_b9f22a713c",
    stage: "Join Graph 校验",
    semanticVersion: "sem-2026.06.18",
    sqlSummary: "未生成 SQL，编译器拒绝多义 Join。",
    resolution: "由语义管理员认证“订单明细 → SKU → 产品线”为默认路径。",
  },
];

export const modelVersions = [
  { name: "Planner", active: "3.2", candidate: "3.3-rc2", traffic: "80 / 20", status: "灰度中" },
  { name: "Entity Linker", active: "2.8", candidate: "2.9-rc1", traffic: "95 / 5", status: "观察中" },
  { name: "Answer", active: "4.1", candidate: "4.2-rc1", traffic: "100 / 0", status: "待门禁" },
];

export const sloItems = [
  { name: "核心问答可用性", value: "99.94%", target: "≥ 99.9%", state: "healthy" },
  { name: "首个状态反馈 P95", value: "1.2s", target: "≤ 1.5s", state: "healthy" },
  { name: "常规查询 P95", value: "11.8s", target: "≤ 15s", state: "healthy" },
  { name: "取消传递 P95", value: "2.7s", target: "≤ 3s", state: "warning" },
] as const;
