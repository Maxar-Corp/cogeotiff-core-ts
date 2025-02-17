import { CogTiff } from '../cog.tiff.js';
import { TiffTag } from '../const/tiff.tag.id.js';
import { TiffTagValueType } from '../const/tiff.tag.value.js';
import { getUint, getUint64 } from '../util/bytes.js';
import { type DataViewOffset, hasBytes } from './data.view.offset.js';
import type { Tag, TagLazy, TagOffset } from './tiff.tag.js';
import { getTiffTagSize } from './tiff.value.reader.js';

function readTagValue(
  fieldType: TiffTagValueType,
  bytes: DataView,
  offset: number,
  isLittleEndian: boolean,
): number | number[] | string | bigint {
  switch (fieldType) {
    case TiffTagValueType.Ascii:
      return String.fromCharCode(bytes.getUint8(offset));

    case TiffTagValueType.Undefined:
    case TiffTagValueType.Uint8:
      return bytes.getUint8(offset);

    case TiffTagValueType.Int8:
      return bytes.getInt8(offset);

    case TiffTagValueType.Uint16:
      return bytes.getUint16(offset, isLittleEndian);

    case TiffTagValueType.Int16:
      return bytes.getInt16(offset, isLittleEndian);

    case TiffTagValueType.Uint32:
      return bytes.getUint32(offset, isLittleEndian);

    case TiffTagValueType.Int32:
      return bytes.getInt32(offset, isLittleEndian);

    case TiffTagValueType.Rational:
      return [bytes.getUint32(offset, isLittleEndian), bytes.getUint32(offset + 4, isLittleEndian)];

    case TiffTagValueType.SignedRational:
      return [bytes.getInt32(offset, isLittleEndian), bytes.getInt32(offset + 4, isLittleEndian)];

    case TiffTagValueType.Float64:
      return bytes.getFloat64(offset, isLittleEndian);

    case TiffTagValueType.Float32:
      return bytes.getFloat32(offset, isLittleEndian);

    case TiffTagValueType.Uint64:
      return getUint64(bytes, offset, isLittleEndian);
    default:
      throw new Error(`Unknown read type "${fieldType}" "${TiffTagValueType[fieldType]}"`);
  }
}

function readValue<T>(tiff: CogTiff, bytes: DataView, offset: number, type: TiffTagValueType, count: number): T {
  const typeSize = getTiffTagSize(type);
  const dataLength = count * typeSize;

  if (count === 1) return readTagValue(type, bytes, offset, tiff.isLittleEndian) as unknown as T;

  switch (type) {
    case TiffTagValueType.Ascii:
      return String.fromCharCode.apply(
        null,
        new Uint8Array(bytes.buffer, offset, dataLength - 1) as unknown as number[],
      ) as unknown as T;
  }

  const output = [];
  for (let i = 0; i < dataLength; i += typeSize) {
    output.push(readTagValue(type, bytes, offset + i, tiff.isLittleEndian));
  }

  return output as unknown as T;
}

/**
 * Determine if all the data for the tiff tag is loaded in and use that to create the specific CogTiffTag
 *
 * @see {@link Tag}
 *
 * @param tiff
 * @param view Bytes to read from
 * @param offset Offset in the dataview to read a tag
 */
export function createTag(tiff: CogTiff, view: DataViewOffset, offset: number): Tag<unknown> {
  const tagId = view.getUint16(offset + 0, tiff.isLittleEndian);

  const dataType = view.getUint16(offset + 2, tiff.isLittleEndian) as TiffTagValueType;
  const dataCount = getUint(view, offset + 4, tiff.ifdConfig.pointer, tiff.isLittleEndian);
  const dataTypeSize = getTiffTagSize(dataType);
  const dataLength = dataTypeSize * dataCount;

  // Tag value is inline read the value
  if (dataLength <= tiff.ifdConfig.pointer) {
    const value = readValue(tiff, view, offset + 4 + tiff.ifdConfig.pointer, dataType, dataCount);
    return { type: 'inline', id: tagId, count: dataCount, value, dataType, tagOffset: offset };
  }

  const dataOffset = getUint(view, offset + 4 + tiff.ifdConfig.pointer, tiff.ifdConfig.pointer, tiff.isLittleEndian);
  switch (tagId) {
    case TiffTag.TileOffsets:
    case TiffTag.TileByteCounts:
    case TiffTag.StripByteCounts:
    case TiffTag.StripOffsets:
      const tag: TagOffset = {
        type: 'offset',
        id: tagId,
        count: dataCount,
        dataType,
        dataOffset,
        isLoaded: false,
        value: [],
        tagOffset: offset,
      };
      // Some offsets are quite long and don't need to read them often, so only read the tags we are interested in when we need to
      if (tagId === TiffTag.TileOffsets && hasBytes(view, dataOffset, dataLength)) setBytes(tag, view);
      return tag;
  }

  // If we already have the bytes in the view read them in
  if (hasBytes(view, dataOffset, dataLength)) {
    const value = readValue(tiff, view, dataOffset - view.sourceOffset, dataType, dataCount);
    return { type: 'inline', id: tagId, count: dataCount, value, dataType, tagOffset: offset };
  }

  return { type: 'lazy', id: tagId, count: dataCount, dataOffset, dataType, tagOffset: offset };
}

/** Fetch the value from a {@link TagLazy} tag */
export async function fetchLazy<T>(tag: TagLazy<T>, tiff: CogTiff): Promise<T> {
  if (tag.value != null) return tag.value;
  const dataTypeSize = getTiffTagSize(tag.dataType);
  const dataLength = dataTypeSize * tag.count;
  const bytes = await tiff.source.fetch(tag.dataOffset, dataLength);
  const view = new DataView(bytes);
  tag.value = readValue(tiff, view, 0, tag.dataType, tag.count);
  return tag.value as T;
}

/**
 * Fetch all the values from a {@link TagOffset}
 */
export async function fetchAllOffsets(tiff: CogTiff, tag: TagOffset): Promise<number[]> {
  const dataTypeSize = getTiffTagSize(tag.dataType);

  if (tag.view == null) {
    const bytes = await tiff.source.fetch(tag.dataOffset, dataTypeSize * tag.count);
    tag.view = new DataView(bytes) as DataViewOffset;
    tag.view.sourceOffset = tag.dataOffset;
  }

  tag.value = readValue(tiff, tag.view, 0, tag.dataType, tag.count) as number[];
  tag.isLoaded = true;
  return tag.value;
}

export function setBytes(tag: TagOffset, view: DataViewOffset): void {
  const dataTypeSize = getTiffTagSize(tag.dataType);
  const startBytes = view.byteOffset + tag.dataOffset - view.sourceOffset;
  tag.view = new DataView(view.buffer.slice(startBytes, startBytes + dataTypeSize * tag.count)) as DataViewOffset;
  tag.view.sourceOffset = tag.dataOffset;
}

/** Partially fetch the values of a {@link TagOffset} and return the value for the offset */
export async function getValueAt(tiff: CogTiff, tag: TagOffset, index: number): Promise<number> {
  if (index > tag.count || index < 0) throw new Error('TagOffset: out of bounds :' + index);
  if (tag.value[index] != null) return tag.value[index];
  const dataTypeSize = getTiffTagSize(tag.dataType);

  if (tag.view == null) {
    const bytes = await tiff.source.fetch(tag.dataOffset + index * dataTypeSize, dataTypeSize);
    const view = new DataView(bytes);
    const value = readValue(tiff, view, 0, tag.dataType, 1) as number;
    tag.value[index] = value;
    return value;
  }

  const value = readValue(tiff, tag.view, index * dataTypeSize, tag.dataType, 1) as number;
  tag.value[index] = value;
  return value;
}
