/**
 * 現在位置を指定数だけ進める。
 *
 * tokens.lengthまでは移動できる。
 *
 * tokens.lengthは
 * 「最後のTokenの次（EOF）」を表すため、
 * 正常な位置として扱う。
 *
 * ただし、それを超える移動は
 * Parserの不具合の可能性が高いため、
 * RangeErrorを送出する。
 *
 * @param {number} count
 * @returns {TokenReader}
 */
advance(count = 1) {
  if (
    !Number.isInteger(count) ||
    count < 0
  ) {
    throw new TypeError(
      "TokenReader.advance: count must be a non-negative integer."
    );
  }

  const targetIndex =
    this.index + count;

  if (
    targetIndex >
    this.tokens.length
  ) {
    throw new RangeError(
      `TokenReader.advance: cannot advance from index ${this.index} by ${count}. ` +
      `Target index ${targetIndex} exceeds EOF (${this.tokens.length}).`
    );
  }

  this.index = targetIndex;

  return this;
}