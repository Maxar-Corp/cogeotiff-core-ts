import { CogTiffImage } from './cog.tiff.image.js';
import { TiffEndian } from './const/tiff.endian.js';
import { TiffTag } from './const/tiff.tag.id.js';
import { TiffVersion } from './const/tiff.version.js';
import { type Tag } from './index.js';
import { type DataViewOffset, hasBytes } from './read/data.view.offset.js';
import { CogTifGhostOptions } from './read/tiff.gdal.js';
import { TagTiffBigConfig, TagTiffConfig, type TiffIfdConfig } from './read/tiff.ifd.config.js';
import { createTag } from './read/tiff.tag.factory.js';
import { type Source } from './source.js';
import { getUint } from './util/bytes.js';
import { toHex } from './util/util.hex.js';

export class CogTiff {
  /** Read 16KB blocks at a time */
  fixedHeaderSize?: number;
  /** Read 16KB blocks at a time */
  defaultReadSize = 16 * 1024;
  /** Where this cog is fetching its data from */
  source: Source;
  /** Big or small Tiff */
  version = TiffVersion.Tiff;
  /** List of images, o is the base image */
  images: CogTiffImage[] = [];
  /** Ghost header options */
  options?: CogTifGhostOptions;
  /** Configuration for the size of the IFD */
  ifdConfig: TiffIfdConfig = TagTiffConfig;
  /** Is the tiff being read is little Endian */
  isLittleEndian = false;
  /** Has init() been called */
  isInitialized = false;

  private _initPromise?: Promise<CogTiff>;
  constructor(source: Source, headerSize?: number, tileSize?: number) {
    this.source = source;
    if (typeof headerSize !== 'undefined') {
        this.fixedHeaderSize = headerSize;
    }
    if (typeof tileSize !== 'undefined') {
      this.defaultReadSize = tileSize;
    }
  }

  /** Create a COG and initialize it by reading the COG headers */
  static create(source: Source): Promise<CogTiff> {
    return new CogTiff(source).init();
  }
  static createEx(source: Source, headerSize: number, tileSize: number): Promise<CogTiff> {
    return new CogTiff(source, headerSize, tileSize).init();
  }

  /**
   * Initialize the COG loading in the header and all image headers
   */
  init(): Promise<CogTiff> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this.readHeader();
    return this._initPromise;
  }

  /**
   * Find a image which has a resolution similar to the provided resolution
   *
   * @param resolution resolution to find
   */
  getImageByResolution(resolution: number): CogTiffImage {
    const firstImage = this.images[0];
    const firstImageSize = firstImage.size;
    const [refX] = firstImage.resolution;

    const resolutionBaseX = refX * firstImageSize.width;
    // const resolutionBaseY = refY * firstImageSize.height;
    for (let i = this.images.length - 1; i > 0; i--) {
      const img = this.images[i];
      const imgSize = img.size;

      const imgResolutionX = resolutionBaseX / imgSize.width;
      // TODO do we care about y resolution
      // const imgResolutionY = resolutionBaseY / imgSize.height;

      if (imgResolutionX - resolution <= 0.01) return img;
    }
    return firstImage;
  }

  /**
   * Return resolution of each image
   */
  getResolutions(): Array<[number, number, number]> {
    const resolutions: [number, number, number][] = [];
    for (let img of this.images) {
      resolutions.push(img.resolution);
    }
    return resolutions;
  }

  /** Read the Starting header and all Image headers from the source */
  private async readHeader(): Promise<CogTiff> {
    if (this.isInitialized) return this;
    const readSize = typeof this.fixedHeaderSize !== 'undefined' ? this.fixedHeaderSize : this.defaultReadSize;
    const bytes = new DataView(await this.source.fetch(0, readSize)) as DataViewOffset;
    bytes.sourceOffset = 0;

    let offset = 0;
    const endian = bytes.getUint16(offset, this.isLittleEndian);
    offset += 2;

    this.isLittleEndian = endian === TiffEndian.Little;
    if (!this.isLittleEndian) throw new Error('Only little endian is supported');
    this.version = bytes.getUint16(offset, this.isLittleEndian);
    offset += 2;

    let nextOffsetIfd: number;
    if (this.version === TiffVersion.BigTiff) {
      this.ifdConfig = TagTiffBigConfig;
      const pointerSize = bytes.getUint16(offset, this.isLittleEndian);
      offset += 2;
      if (pointerSize !== 8) throw new Error('Only 8byte pointers are supported');
      const zeros = bytes.getUint16(offset, this.isLittleEndian);
      offset += 2;
      if (zeros !== 0) throw new Error('Invalid big tiff header');
      nextOffsetIfd = getUint(bytes, offset, this.ifdConfig.pointer, this.isLittleEndian);
      offset += this.ifdConfig.pointer;
    } else if (this.version === TiffVersion.Tiff) {
      nextOffsetIfd = getUint(bytes, offset, this.ifdConfig.pointer, this.isLittleEndian);
      offset += this.ifdConfig.pointer;
    } else {
      throw new Error(`Only tiff supported version:${this.version}`);
    }

    const ghostSize = nextOffsetIfd - offset;
    // GDAL now stores metadata between the IFD inside a ghost storage area
    if (ghostSize > 0 && ghostSize < 16 * 1024) {
      this.options = new CogTifGhostOptions();
      this.options.process(bytes, offset, ghostSize);
    }

    while (nextOffsetIfd !== 0) {
      let lastView = bytes;

      // Ensure at least 1KB near at the IFD offset is ready for reading
      // TODO is 1KB enough, most IFD entries are in the order of 100-300 bytes
      if(typeof this.fixedHeaderSize === 'undefined'){
        if (!hasBytes(lastView, nextOffsetIfd, 1024)) {
        const bytes = await this.source.fetch(
          nextOffsetIfd,
          getMaxLength(this.source, nextOffsetIfd, this.defaultReadSize),
        );
        lastView = new DataView(bytes) as DataViewOffset;
        lastView.sourceOffset = nextOffsetIfd;
      }
      }
      
      nextOffsetIfd = await this.readIfd(nextOffsetIfd, lastView);
    }

    await Promise.all(this.images.map((i) => i.init()));
    this.isInitialized = true;
    return this;
  }

  /**
   * Read a IFD at a the provided offset
   *
   * @param offset file offset to read the header from
   * @param view offset that contains the bytes for the header
   */
  private async readIfd(offset: number, view: DataViewOffset): Promise<number> {
    const viewOffset = offset - view.sourceOffset;
    const tagCount = getUint(view, viewOffset, this.ifdConfig.offset, this.isLittleEndian);

    const tags: Map<TiffTag, Tag> = new Map();

    // We now know how many bytes we need so ensure the ifd bytes are all read
    const ifdBytes = tagCount * this.ifdConfig.ifd;
    if (!hasBytes(view, offset, ifdBytes)) {
      throw new Error('IFD out of range @ ' + toHex(offset) + ' IFD' + this.images.length);
    }

    const ifdSize = this.ifdConfig.ifd;
    const startOffset = viewOffset + this.ifdConfig.offset;
    for (let i = 0; i < tagCount; i++) {
      const tag = createTag(this, view, startOffset + i * ifdSize);
      tags.set(tag.id, tag);
    }

    this.images.push(new CogTiffImage(this, this.images.length, tags));
    return getUint(view, startOffset + tagCount * ifdSize, this.ifdConfig.pointer, this.isLittleEndian);
  }
}

function getMaxLength(source: Source, offset: number, length: number): number {
  // max length is unknown, roll the dice and hope the chunk exists
  if (source.metadata?.size == null) return length;
  const size = source.metadata.size;

  // Read was going to happen past the end of the file limit it to the end of the file
  if (offset + length > size) return size - offset;
  return length;
}
