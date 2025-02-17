import { getUint } from './util/bytes.js';
import { CogTiff } from './cog.tiff.js';
import { TiffCompression, TiffMimeType } from './const/tiff.mime.js';
import { TiffTag, TiffTagGeo } from './const/tiff.tag.id.js';
import type { Tag, TagInline, TagOffset } from './read/tiff.tag.js';
import type { BoundingBox, Size } from './vector.js';
import { fetchAllOffsets, fetchLazy, getValueAt } from './read/tiff.tag.factory.js';

/** Invalid EPSG code */
export const InvalidProjectionCode = 32767;

/**
 * Number of tiles used inside this image
 */
export interface CogTiffImageTiledCount {
  /** Number of tiles on the x axis */
  x: number;
  /** Number of tiles on the y axis */
  y: number;
}

/** Tags that are commonly accessed for geotiffs */
export const ImportantTags = new Set([
  TiffTag.Compression,
  TiffTag.ImageHeight,
  TiffTag.ImageWidth,
  TiffTag.ModelPixelScale,
  TiffTag.ModelTiePoint,
  TiffTag.ModelTransformation,
  TiffTag.TileHeight,
  TiffTag.TileWidth,
  TiffTag.GeoKeyDirectory,
  TiffTag.GeoAsciiParams,
  TiffTag.GeoDoubleParams,
  TiffTag.TileOffsets,
]);

/**
 * Size of a individual tile
 */
export interface CogTiffImageTileSize {
  /** Tile width (pixels) */
  width: number;
  /** Tile height (pixels) */
  height: number;
}

export class CogTiffImage {
  /** All IFD tags that have been read for the image */
  tags: Map<TiffTag, Tag>;
  /**
   * Id of the tif image, generally the image index inside the tif
   * where 0 is the root image, and every sub image is +1
   *
   * @example 0, 1, 2
   */
  id: number;
  /** Reference to the TIFF that owns this image */
  tiff: CogTiff;
  /** Has loadGeoTiffTags been called */
  isGeoTagsLoaded = false;
  /** Sub tags stored in TiffTag.GeoKeyDirectory */
  tagsGeo: Map<TiffTagGeo, string | number> = new Map();

  constructor(tiff: CogTiff, id: number, tags: Map<TiffTag, Tag>) {
    this.tiff = tiff;
    this.id = id;
    this.tags = tags;
  }

  /**
   * Force loading of important tags if they have not already been loaded
   *
   * @param loadGeoTags Whether to load the GeoKeyDirectory and unpack it
   */
  async init(loadGeoTags = true): Promise<void> {
    const requiredTags = [
      this.fetch(TiffTag.SamplesPerPixel),
      this.fetch(TiffTag.SampleFormat),
      this.fetch(TiffTag.BitsPerSample),
      this.fetch(TiffTag.Compression),
      this.fetch(TiffTag.ImageHeight),
      this.fetch(TiffTag.ImageWidth),
      this.fetch(TiffTag.ModelPixelScale),
      this.fetch(TiffTag.ModelTiePoint),
      this.fetch(TiffTag.ModelTransformation),
      this.fetch(TiffTag.TileHeight),
      this.fetch(TiffTag.TileWidth),
    ];

    if (loadGeoTags) {
      requiredTags.push(this.fetch(TiffTag.GeoKeyDirectory));
      requiredTags.push(this.fetch(TiffTag.GeoAsciiParams));
      requiredTags.push(this.fetch(TiffTag.GeoDoubleParams));
    }

    await Promise.all(requiredTags);
    if (loadGeoTags) await this.loadGeoTiffTags();
  }

  /**
   * Get the value of a TiffTag if it has been loaded, null otherwise
   *
   * if the value is not loaded @see {CogTiffImage.fetch}
   * @returns value if loaded, null otherwise
   */
  value<T>(tag: TiffTag): T | null {
    const sourceTag = this.tags.get(tag);
    if (sourceTag == null) return null;
    if (sourceTag.type === 'offset' && sourceTag.isLoaded === false) return null;
    return sourceTag.value as T;
  }

  /**
   * Load and unpack the GeoKeyDirectory
   *
   * @see {TiffTag.GeoKeyDirectory}
   */
  async loadGeoTiffTags(): Promise<void> {
    // Already loaded
    if (this.isGeoTagsLoaded) return;
    const sourceTag = this.tags.get(TiffTag.GeoKeyDirectory);
    if (sourceTag == null) {
      this.isGeoTagsLoaded = true;
      return;
    }
    if (sourceTag.type === 'lazy' && sourceTag.value == null) {
      // Load all the required keys
      await Promise.all([
        this.fetch(TiffTag.GeoKeyDirectory),
        this.fetch(TiffTag.GeoAsciiParams),
        this.fetch(TiffTag.GeoDoubleParams),
      ]);
    }
    this.isGeoTagsLoaded = true;
    if (sourceTag.value == null) return;
    const geoTags = sourceTag.value as Uint16Array;
    if (typeof geoTags === 'number') throw new Error('Invalid geo tags found');
    for (let i = 4; i <= geoTags[3] * 4; i += 4) {
      const key = geoTags[i] as TiffTagGeo;
      const locationTagId = geoTags[i + 1];

      const offset = geoTags[i + 3];

      if (locationTagId === 0) {
        this.tagsGeo.set(key, offset);
        continue;
      }

      const tag = this.tags.get(locationTagId);
      if (tag == null || tag.value == null) continue;
      const count = geoTags[i + 2];
      if (typeof tag.value === 'string') {
        this.tagsGeo.set(key, tag.value.slice(offset, offset + count - 1).trim());
      } else {
        throw new Error('Failed to extract GeoTiffTags');
      }
    }
  }

  /**
   * Get the associated TiffTagGeo
   *
   * @example
   * ```typescript
   * image.valueGeo(TiffTagGeo.GTRasterTypeGeoKey)
   * ```
   * @throws if {@link loadGeoTiffTags} has not been called
   */
  valueGeo(tag: TiffTagGeo): string | number | undefined {
    if (this.isGeoTagsLoaded === false) throw new Error('loadGeoTiffTags() has not been called');
    return this.tagsGeo.get(tag);
  }

  /**
   * Load a tag, if it is not currently loaded, fetch the required data for the tag.
   *
   * @param tag tag to fetch
   */
  public async fetch<T>(tag: TiffTag): Promise<T | null> {
    const sourceTag = this.tags.get(tag);
    if (sourceTag == null) return null;
    if (sourceTag.type === 'inline') return sourceTag.value as unknown as T;
    if (sourceTag.type === 'lazy') return fetchLazy(sourceTag, this.tiff) as T;
    if (sourceTag.isLoaded) return sourceTag.value as unknown as T;
    if (sourceTag.type === 'offset') return fetchAllOffsets(this.tiff, sourceTag) as T;
    throw new Error('Cannot fetch:' + tag);
  }

  /**
   * Get the origin point for the image
   *
   * @returns origin point of the image
   */
  get origin(): [number, number, number] {
    const tiePoints: number[] | null = this.value<number[]>(TiffTag.ModelTiePoint);
    if (tiePoints != null && tiePoints.length === 6) {
      return [tiePoints[3], tiePoints[4], tiePoints[5]];
    }

    const modelTransformation = this.value<number[]>(TiffTag.ModelTransformation);
    if (modelTransformation != null) {
      return [modelTransformation[3], modelTransformation[7], modelTransformation[11]];
    }

    // If this is a sub image, use the origin from the top level image
    if (this.value(TiffTag.NewSubFileType) === 1 && this.id !== 0) {
      return this.tiff.images[0].origin;
    }

    throw new Error('Image does not have a geo transformation.');
  }

  /** Is there enough geo information on this image to figure out where its actually located */
  get isGeoLocated(): boolean {
    const isImageLocated =
      this.value(TiffTag.ModelPixelScale) != null || this.value(TiffTag.ModelTransformation) != null;
    if (isImageLocated) return true;
    // If this is a sub image, use the isGeoLocated from the top level image
    if (this.value(TiffTag.NewSubFileType) === 1 && this.id !== 0) return this.tiff.images[0].isGeoLocated;
    return false;
  }

  /**
   * Get the resolution of the image
   *
   * @returns [x,y,z] pixel scale
   */
  get resolution(): [number, number, number] {
    const modelPixelScale: number[] | null = this.value(TiffTag.ModelPixelScale);
    if (modelPixelScale != null) {
      return [modelPixelScale[0], -modelPixelScale[1], modelPixelScale[2]];
    }
    const modelTransformation: number[] | null = this.value(TiffTag.ModelTransformation);
    if (modelTransformation != null) {
      return [modelTransformation[0], modelTransformation[5], modelTransformation[10]];
    }

    // If this is a sub image, use the resolution from the top level image
    if (this.value(TiffTag.NewSubFileType) === 1 && this.id !== 0) {
      const firstImg = this.tiff.images[0];
      const [resX, resY, resZ] = firstImg.resolution;
      const firstImgSize = firstImg.size;
      const imgSize = this.size;
      // scale resolution based on the size difference between the two images
      return [(resX * firstImgSize.width) / imgSize.width, (resY * firstImgSize.height) / imgSize.height, resZ];
    }

    throw new Error('Image does not have a geo transformation.');
  }

  /**
   * Bounding box of the image
   *
   * @returns [minX, minY, maxX, maxY] bounding box
   */
  get bbox(): [number, number, number, number] {
    const size = this.size;
    const origin = this.origin;
    const resolution = this.resolution;

    if (origin == null || size == null || resolution == null) {
      throw new Error('Unable to calculate bounding box');
    }

    const x1 = origin[0];
    const y1 = origin[1];

    const x2 = x1 + resolution[0] * size.width;
    const y2 = y1 + resolution[1] * size.height;

    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  /**
   * Get the compression used by the tile
   *
   * @see {@link TiffCompression}
   *
   * @returns Compression type eg webp
   */
  get compression(): TiffMimeType | null {
    const compression = this.value(TiffTag.Compression);
    if (compression == null || typeof compression !== 'number') return null;
    return TiffCompression[compression];
  }

  /**
   * Get the photometricInterpretation used by the tile
   *
   * @see {@link PhotometricInterpretation}
   *
   * @returns photometricInterpretation
   * 
   * 0 = WhiteIsZero. For bilevel and grayscale images: 0 is imaged as white.
   * 1 = BlackIsZero. For bilevel and grayscale images: 0 is imaged as black.
   * 2 = RGB. RGB value of (0,0,0) represents black, and (255,255,255) represents white, assuming 8-bit components. The components are stored in the indicated order: first Red, then Green, then Blue.
   * 3 = Palette color. In this model, a color is described with a single component. The value of the component is used as an index into the red, green and blue curves in the ColorMap field to retrieve an RGB triplet that defines the color. When PhotometricInterpretation=3 is used, ColorMap must be present and SamplesPerPixel must be 1.
   * 4 = Transparency Mask. This means that the image is used to define an irregularly shaped region of another image in the same TIFF file. SamplesPerPixel and BitsPerSample must be 1. PackBits compression is recommended. The 1-bits define the interior of the region; the 0-bits define the exterior of the region. 
   * 
   */
  get photometricInterpretation(): number | null {
    const photometricInterpretation = this.value(TiffTag.PhotometricInterpretation);
    if (photometricInterpretation == null || typeof photometricInterpretation !== 'number') return null;
    return photometricInterpretation;
  }

  /**
   * Get the sample format used by the tile
   *
   * @returns sample format "UNSIGNED_INTEGER"=1, "SIGNED_INTEGER"=2, "IEEE_FLOATING_POINT"=3
   */
  get sampleFormat(): number[] | null {
    const sampleFormat = this.value(TiffTag.SampleFormat);
    if (typeof sampleFormat === 'number') return [sampleFormat];
    if (Array.isArray(sampleFormat)) return sampleFormat;
    return null;
  }

  /**
   * Get the bits per sample used by the tile
   *
   * @returns bits per sample
   */
  get bitsPerSample(): number[] | null {
    const bitsPerSample = this.value(TiffTag.BitsPerSample);
    if (typeof bitsPerSample === 'number') return [bitsPerSample];
    if (Array.isArray(bitsPerSample)) return bitsPerSample;
    return null;
  }

  /**
   * Get the samples per pixel used by the tile
   *
   * @returns the number of samples per pixel eg the number of bands in the image
   */
  get samplesPerPixel(): number | null {
    const samplePerPixel = this.value(TiffTag.SamplesPerPixel);
    if (samplePerPixel == null || typeof samplePerPixel !== 'number') return null;
    return samplePerPixel;
  }

  /**
   * Get the GDAL No data value if any
   *
   * @returns the no data value
   */
  get gdalNoData(): number | null {
    const gdalNoData = this.value(TiffTag.GdalNoData);
    if (gdalNoData == null || typeof gdalNoData !== 'number') return null;
    return gdalNoData;
  }

  /**
   * Attempt to read the EPSG Code from TiffGeoTags
   *
   * @returns EPSG Code if it exists
   */
  get epsg(): number | null {
    let projection = this.valueGeo(TiffTagGeo.ProjectedCSTypeGeoKey) as number;
    if (!projection || projection === InvalidProjectionCode)
    {
      projection = this.valueGeo(TiffTagGeo.GeographicTypeGeoKey) as number;
      if (projection === InvalidProjectionCode) return null;
    }
    return projection;
  }

  /**
   * Get the size of the image
   *
   * @returns Size in pixels
   */
  get size(): Size {
    return {
      width: this.value<number>(TiffTag.ImageWidth) as number,
      height: this.value<number>(TiffTag.ImageHeight) as number,
    };
  }

  /**
   * Determine if this image is tiled
   */
  public isTiled(): boolean {
    return this.value(TiffTag.TileWidth) !== null;
  }

  /**
   * Get size of individual tiles
   */
  get tileSize(): CogTiffImageTileSize {
    return {
      width: this.value<number>(TiffTag.TileWidth) as number,
      height: this.value<number>(TiffTag.TileHeight) as number,
    };
  }

  /**
   * Number of tiles used to create this image
   */
  get tileCount(): CogTiffImageTiledCount {
    const size = this.size;
    const tileSize = this.tileSize;
    const x = Math.ceil(size.width / tileSize.width);
    const y = Math.ceil(size.height / tileSize.height);
    return { x, y };
  }

  /**
   * Get the pointer to where the tiles start in the Tiff file
   *
   * @remarks Used to read tiled tiffs
   *
   * @returns file offset to where the tiffs are stored
   */
  get tileOffset(): TagOffset {
    const tileOffset = this.tags.get(TiffTag.TileOffsets) as TagOffset;
    if (tileOffset == null) throw new Error('No tile offsets found');
    return tileOffset;
  }

  /**
   * Get the number of strip's inside this tiff
   *
   * @remarks Used to read striped tiffs
   *
   * @returns number of strips present
   */
  get stripCount(): number {
    const tileOffset = this.tags.get(TiffTag.StripByteCounts) as TagOffset;
    if (tileOffset == null) return 0;
    return tileOffset.count;
  }

  // Clamp the bounds of the output image to the size of the image, as sometimes the edge tiles are not full tiles
  getTileBounds(x: number, y: number): BoundingBox {
    const { size, tileSize } = this;
    const top = y * tileSize.height;
    const left = x * tileSize.width;
    const width = left + tileSize.width >= size.width ? size.width - left : tileSize.width;
    const height = top + tileSize.height >= size.height ? size.height - top : tileSize.height;
    return { x: left, y: top, width, height };
  }

  /**
   * Read a strip into a ArrayBuffer
   *
   * Image has to be striped see {@link stripCount}
   *
   * @param index Strip index to read
   */
  async getStrip(index: number): Promise<{ mimeType: TiffMimeType; bytes: ArrayBuffer } | null> {
    if (this.isTiled()) throw new Error('Cannot read stripes, tiff is tiled: ' + index);

    const byteCounts = this.tags.get(TiffTag.StripByteCounts) as TagOffset;
    const offsets = this.tags.get(TiffTag.StripOffsets) as TagOffset;

    if (index >= byteCounts.count) throw new Error('Cannot read strip, index out of bounds');

    const [byteCount, offset] = await Promise.all([
      getOffset(this.tiff, offsets, index),
      getOffset(this.tiff, byteCounts, index),
    ]);
    return this.getBytes(byteCount, offset);
  }

  /** The jpeg header is stored in the IFD, read the JPEG header and adjust the byte array to include it */
  private getJpegHeader(bytes: ArrayBuffer): ArrayBuffer {
    // Both the JPEGTable and the Bytes with have the start of image and end of image markers
    // StartOfImage 0xffd8 EndOfImage 0xffd9
    const tables = this.value<number[]>(TiffTag.JPEGTables);
    if (tables == null) throw new Error('Unable to find Jpeg header');

    // Remove EndOfImage marker
    const tableData = tables.slice(0, tables.length - 2);
    const actualBytes = new Uint8Array(bytes.byteLength + tableData.length - 2);
    actualBytes.set(tableData, 0);
    actualBytes.set(new Uint8Array(bytes).slice(2), tableData.length);
    return actualBytes;
  }

  /** Read image bytes at the given offset */
  private async getBytes(
    offset: number,
    byteCount: number,
  ): Promise<{ mimeType: TiffMimeType; bytes: ArrayBuffer } | null> {
    const mimeType = this.compression;
    if (mimeType == null) throw new Error('Unsupported compression: ' + this.value(TiffTag.Compression));
    if (byteCount === 0) return null;

    const bytes = await this.tiff.source.fetch(offset, byteCount);
    if (bytes.byteLength < byteCount) {
      throw new Error(`Failed to fetch bytes from offset:${offset} wanted:${byteCount} got:${bytes.byteLength}`);
    }
    if (this.compression === TiffMimeType.Jpeg) return { mimeType, bytes: this.getJpegHeader(bytes) };
    return { mimeType, bytes };
  }

  /**
   * Load a tile into a ArrayBuffer
   *
   * if the tile compression is JPEG, This will also apply the JPEG compression tables to the resulting ArrayBuffer see {@link getJpegHeader}
   *
   * @param x Tile x offset
   * @param y Tile y offset
   */
  async getTile(x: number, y: number): Promise<{ mimeType: TiffMimeType; bytes: ArrayBuffer } | null> {
    const mimeType = this.compression;
    const size = this.size;
    const tiles = this.tileSize;

    if (tiles == null) throw new Error('Tiff is not tiled');
    if (mimeType == null) throw new Error('Unsupported compression: ' + this.value(TiffTag.Compression));

    // TODO support GhostOptionTileOrder
    const nyTiles = Math.ceil(size.height / tiles.height);
    const nxTiles = Math.ceil(size.width / tiles.width);

    if (x >= nxTiles || y >= nyTiles) {
      throw new Error(`Tile index is outside of range x:${x} >= ${nxTiles} or y:${y} >= ${nyTiles}`);
    }

    const idx = y * nxTiles + x;
    const totalTiles = nxTiles * nyTiles;
    if (idx >= totalTiles) throw new Error(`Tile index is outside of tile range: ${idx} >= ${totalTiles}`);

    const { offset, imageSize } = await this.getTileSize(idx);

    return this.getBytes(offset, imageSize);
  }

  /**
   * Does this tile exist in the tiff and does it actually have a value
   *
   * Sparse tiffs can have a lot of empty tiles, they set the tile size to `0 bytes` when the tile is empty
   * this checks the tile byte size to validate if it actually has any data.
   *
   * @param x Tile x offset
   * @param y Tile y offset
   *
   * @returns if the tile exists and has data
   */
  async hasTile(x: number, y: number): Promise<boolean> {
    const tiles = this.tileSize;
    const size = this.size;

    if (tiles == null) throw new Error('Tiff is not tiled');

    // TODO support GhostOptionTileOrder
    const nyTiles = Math.ceil(size.height / tiles.height);
    const nxTiles = Math.ceil(size.width / tiles.width);
    if (x >= nxTiles || y >= nyTiles) return false;
    const idx = y * nxTiles + x;
    const ret = await this.getTileSize(idx);
    return ret.offset > 0;
  }

  /**
   * Load the offset and byteCount of a tile
   * @param index index in the tile array
   * @returns Offset and byteCount for the tile
   */
  async getTileSize(index: number): Promise<{ offset: number; imageSize: number }> {
    // GDAL optimizes tiles by storing the size of the tile in
    // the few bytes leading up to the tile
    const leaderBytes = this.tiff.options?.tileLeaderByteSize;
    if (leaderBytes) {
      const offset = await getOffset(this.tiff, this.tileOffset, index);
      // Sparse COG no data found
      if (offset === 0) return { offset: 0, imageSize: 0 };

      // This fetch will generally load in the bytes needed for the image too
      // provided the image size is less than the size of a chunk
      const bytes = await this.tiff.source.fetch(offset - leaderBytes, leaderBytes);
      return { offset, imageSize: getUint(new DataView(bytes), 0, leaderBytes, this.tiff.isLittleEndian) };
    }

    const byteCounts = this.tags.get(TiffTag.TileByteCounts) as TagOffset;
    if (byteCounts == null) throw new Error('No tile byte counts found');
    const [offset, imageSize] = await Promise.all([
      getOffset(this.tiff, this.tileOffset, index),
      getOffset(this.tiff, byteCounts, index),
    ]);
    return { offset, imageSize };
  }
}

function getOffset(
  tiff: CogTiff,
  x: TagOffset | TagInline<number | number[]>,
  index: number,
): number | Promise<number> {
  if (index > x.count || index < 0) throw new Error('TagIndex: out of bounds ' + x.id + ' @ ' + index);
  if (x.type === 'inline') {
    if (x.count > 1) return (x.value as number[])[index] as number;
    return x.value as number;
  }
  return getValueAt(tiff, x, index);
}
