/**
 * 現在位置を指定数だけ戻す。
 *
 * indexは0未満へ移動できない。
 *
 * 0は先頭Tokenを表す有効な位置であり、
 * それより前は存在しない。
 *
 * 0未満へ移動しようとした場合は、
 * Parserの不具合の可能性が高いため、
 * RangeErrorを送出する。
 *
 * @param {number} count
 * @returns {TokenReader}
 */
rewind(count = 1) {
  if (
    !Number.isInteger(count) ||
    count < 0
  ) {
    throw new TypeError(
      "TokenReader.rewind: count must be a non-negative integer."
    );
  }

  const targetIndex =
    this.index - count;

  if (
    targetIndex < 0
  ) {
    throw new RangeError(
      `TokenReader.rewind: cannot rewind from index ${this.index} by ${count}. ` +
      `Target index ${targetIndex} is before the beginning of the token array.`
    );
  }

  this.index = targetIndex;

  return this;
}