/**
 * G1 内容安全闸门 — 检测 agent 输出中的敏感信息泄露
 * 拦截：明文密码、API Key、Token、PEM 私钥等
 * 适用级别：L1/L2/L3 全级别
 * @module gate-content-safety
 */

// ============================================================================
// 类型
// ============================================================================

/** 闸门通用返回结果 */
export interface GateResult {
  pass: boolean;
  blocks: string[];
  reason?: string;
}

// ============================================================================
// 检测规则
// ============================================================================

interface Rule { regex: RegExp; label: string }

const RULES: Rule[] = [
  { regex: /password\s*[=:]\s*['"][^'"]+['"]/gi,  label: "明文密码赋值" },
  { regex: /secret\s*[=:]\s*['"][^'"]{4,}['"]/gi,  label: "明文 Secret 赋值" },
  { regex: /api[_-]?key\s*[=:]\s*['"][^'"]{6,}['"]/gi, label: "明文 API Key 泄露" },
  { regex: /(?:access_)?token\s*[=:]\s*['"][^'"]{6,}['"]/gi, label: "明文 Token 泄露" },
  { regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi, label: "私钥泄露 (BEGIN)" },
  { regex: /-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi,   label: "私钥泄露 (END)" },
  { regex: /AKIA[0-9A-Z]{16}/g, label: "AWS Access Key 泄露" },
  { regex: /(?:auth|credential|secret|key)\s*[=:]\s*['"]?[A-Za-z0-9+/=]{20,}['"]?/gi, label: "疑似凭证泄露" },
];

// ============================================================================
// 导出函数
// ============================================================================

/**
 * G1 内容安全闸门
 * 扫描 agent 输出文本，检测敏感信息模式。
 * @param output - agent 输出的完整文本
 * @returns 通过状态与被拦截规则列表
 */
export function gateContentSafety(output: string): GateResult {
  if (!output || typeof output !== "string") return { pass: true, blocks: [] };

  const blocks = RULES
    .filter(r => { r.regex.lastIndex = 0; return r.regex.test(output); })
    .map(r => r.label);

  if (blocks.length > 0) {
    return {
      pass: false,
      blocks,
      reason: `检测到 ${blocks.length} 类敏感信息泄露：${blocks.join("、")}`,
    };
  }
  return { pass: true, blocks: [] };
}
