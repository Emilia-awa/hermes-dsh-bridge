/**
 * contract.ts — 宿主契约的单一事实来源(single source of truth)。
 *
 * 为什么需要它(DISCUSS_20261003 §3.0):
 *   历史上两次事故(0.1.5 `sessionPersistence` 服务形状重组、0.1.7 `MessageSourceMap` 收紧)
 *   有完全相同的三要素结构 —— 契约依赖是**隐式**的(散落在 `ctx.get()` 内联强转 + 直接 import 里),
 *   变更检测是**事后**的(等用户报障), 失败是**静默**的(无报错、功能不工作)。
 *   本文件打掉第一条: 把「桥插件依赖的全部宿主契约」收敛成一份可机读、可 diff、可测试的清单。
 *
 * 设计要点(DISCUSS_20261003 §3.1):
 *   - **不做版本号比较**: 延续桥现有的「运行时探测」哲学, 天然兼容 0.1.2 / 0.1.5 / 0.1.7 / 0.2.x;
 *   - **不抛错**: 探测结果只用于「告警 + 暴露」, 绝不阻断启动 —— 保留桥现有的降级能力
 *     (如 `apiProxy` 缺失自动降级 `builtin`/`file-push`);
 *   - **一次探测, 多处复用**: 同时服务于 A1(启动自检)、status_get(运行态暴露)、
 *     `scripts/contract_probe.mjs`(离线可 diff 基线)与 `scripts/doctor.mjs`(安装自检)。
 *
 * 维护规则: 每次新增 `ctx.get('<key>')` / `ctx.<service>` / 宿主包直接 import, **必须**在此登记。
 * 补充规则(r6 §A-2): `methods` 必须覆盖**所有被调用的**宿主方法, 而不只是核心链路方法 ——
 *   `harness_list_tools` 曾调用从未存在的 `ctx.tools.keys()`, 而清单只登记了 `register`,
 *   于是自检长期报绿而功能一直是坏的。漏登记不会有任何提示, 因此宁可多登记。
 */
/** 契约项的稳定标识: `required` 用 `pkg#export`, `services` 用服务 key */
export type ContractItemId = string;
/** 宿主包直接 import 的必需符号(缺失 = 插件加载/核心链路直接坏) */
export interface RequiredSymbol {
    /** 宿主包名(仅作标识与报错用; 校验走已 import 的绑定, 不做二次 module 解析) */
    pkg: string;
    /** 导出符号名 */
    export: string;
    /** 期望的 typeof(全部为 'function'; 保留字段以便将来登记常量/对象型契约) */
    kind: 'function' | 'object' | 'string';
    /** 该符号在桥里的用途(报错时自解释) */
    usage: string;
}
/** 宿主服务契约(ctx.get(key, false) 存在性 + 期望方法存在性) */
export interface ServiceContract {
    /** 注入 key(与 `ctx.get('<key>', false)` 的入参逐字一致) */
    key: string;
    /** true = 缺失即核心功能不可用; false = 缺失属预期内降级 */
    required: boolean;
    /** 期望存在的方法名(空数组 = 只要服务存在即可, 方法逐个探测式使用) */
    methods: readonly string[];
    /** 缺失/不完整时的后果说明(报错时自解释) */
    usage: string;
}
/** 契约探测结果(暴露给 status_get 与 contract_probe.mjs) */
export interface ContractReport {
    /** 全部必需项(符号 + 必需服务)齐备 = true */
    ok: boolean;
    /** 缺失的必需项 id(非空即应在启动日志里出现 ⛔ 告警) */
    missingRequired: ContractItemId[];
    /** 缺失的可选项 id(非空只 warn) */
    missingOptional: ContractItemId[];
    /** 服务存在但期望方法缺失的项(`key.method` 形态; 归入对应必需/可选等级) */
    incompleteMethods: ContractItemId[];
    /** 探测时刻(ms epoch, 便于判断 status_get 里的结果有多新) */
    checkedAt: number;
    /** 已探测的契约项总数(便于一眼看出清单是否被意外清空) */
    checkedCount: number;
}
/**
 * 宿主契约清单 —— 与 DISCUSS_20261003 §2.1 的核对表逐条对应。
 *
 * `required` 覆盖桥的 3 个直接 import 符号(`dsh-llm#createUserMessage`、
 * `dsh-session#SessionId`、`dsh-scope#scopeOf`)。
 * `services` 覆盖 §3.1 骨架里列出的 11 个服务, 并补上 `llm`(桥用它解析 provider/model)。
 *
 * ⚠️ 注意: `required` 里的符号校验的是**已 import 的绑定**(`probeHostContract` 的入参),
 *    不是重新解析模块 —— 因为 import 失败会在插件加载阶段直接炸, 根本到不了 apply();
 *    这里校验的是「绑定是否为期望的函数」, 用于捕获**导出被改名 / 变成非函数**这类静默变更。
 */
export declare const HOST_CONTRACT: {
    readonly required: readonly RequiredSymbol[];
    readonly services: readonly ServiceContract[];
};
/** `required` 项的稳定 id: `pkg#export` */
export declare function symbolId(s: RequiredSymbol): string;
/** 服务项的稳定 id: 服务 key 本身 */
export declare function serviceId(s: ServiceContract): string;
/** 探测入参: 桥运行时能拿到的东西(便于单测注入假 ctx / 假绑定) */
export interface ProbeInput {
    /** cordis Context(只用到 ctx.get(key, false)) */
    ctx: {
        get: (key: string, strict?: boolean) => unknown;
    };
    /** 已 import 的必需符号绑定(默认取模块顶层 import; 单测可注入替身) */
    symbols?: Readonly<Record<string, unknown>>;
}
/**
 * 运行时探测宿主契约。
 *
 * - **符号**: `typeof binding === 'function'`(期望 kind 为 function 时);
 * - **服务**: `ctx.get(key, false)` 宽松读取 —— 存在性 + 期望方法存在性;
 * - **不做版本号比较**, **不抛错**: 探测本身任何异常都被兜底为「该项缺失」,
 *   绝不因为探测失败而影响插件启动。
 *
 * 返回结构稳定(`ContractReport`), 可直接被 status_get 序列化、被 contract_probe.mjs 落盘 diff。
 */
export declare function probeHostContract(input: ProbeInput): ContractReport;
