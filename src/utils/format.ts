import Decimal from 'decimal.js';

// 将不同类型的数值统一转换为 Decimal，方便后续格式化。
function toDecimal(value: Decimal | string | number): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return new Decimal(value);
}

export function formatCurrency(
  value: Decimal | string | number,
  fractionDigits = 2,
): string {
  // 输出指定小数位的字符串，默认保留两位小数。
  return toDecimal(value).toFixed(fractionDigits);
}
