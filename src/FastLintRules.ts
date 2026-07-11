export type FastRuleSetName = 'minimal' | 'standard' | 'strict' | 'esp32' | 'stm32';

const CORE_RULES = [
  'delay-blocking',
  'delay-microseconds-long',
  'analog-write-range',
  'serial-begin-baud',
  'interrupt-caution',
  'no-interrupts-warning'
];

const MEMORY_RULES = [
  'string-fragmentation',
  'malloc-warning',
  'new-warning',
  'large-array'
];

const PERFORMANCE_RULES = [
  'float-in-loop',
  'frequent-digital-write',
  'modulo-power-of-two',
  'division-operation'
];

const STYLE_RULES = ['magic-number-pin', 'empty-setup', 'empty-loop'];

const BOARD_RULES: Record<'esp32' | 'stm32', string[]> = {
  esp32: ['esp32-wifi-begin', 'esp32-task-stack', 'esp32-dual-core', 'esp32-watchdog', 'esp32-gpio-isr'],
  stm32: ['stm32-hal-init', 'stm32-clock-config']
};

export function getFastRuleIds(ruleSet: FastRuleSetName = 'standard'): Set<string> {
  if (ruleSet === 'minimal') return new Set(['delay-blocking']);

  const rules = [...CORE_RULES, ...MEMORY_RULES];
  if (ruleSet !== 'standard') rules.push(...PERFORMANCE_RULES, ...STYLE_RULES);
  if (ruleSet === 'esp32' || ruleSet === 'stm32') rules.push(...BOARD_RULES[ruleSet]);
  return new Set(rules);
}