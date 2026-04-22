import { promises as fs } from 'fs';
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { TestFileSource } from '../__benchmark__/source.file.js';
import { SourceMemory } from '../__benchmark__/source.memory.js';
import { ByteSize } from '../util/bytes.js';
import { CogTiff } from '../cog.tiff.js';
import { TiffMimeType } from '../const/tiff.mime.js';
import { TiffTag } from '../const/tiff.tag.id.js';
import type { Source } from '../source.js';
import type { TagOffset } from '../read/tiff.tag.js';

// 900913 properties.
const A = 6378137.0;
const InitialResolution = (2 * Math.PI * A) / 256;

function getResolution(zoom: number): number {
  return InitialResolution / 2 ** zoom;
}

describe('CogTiled', () => {
  const cogSourceFile = new TestFileSource(new URL('../../data/rgba8_tiled.tiff', import.meta.url));
  const cog = new CogTiff(cogSourceFile);

  beforeEach(() => cog.init());

  it('should match resolutions to web mercator zoom levels', () => {
    for (let i = 0; i < 14; i++) {
      assert.equal(cog.getImageByResolution(getResolution(i)).id, 4);
    }

    assert.equal(cog.getImageByResolution(getResolution(14)).id, 3);
    assert.equal(cog.getImageByResolution(getResolution(15)).id, 2);
    assert.equal(cog.getImageByResolution(getResolution(16)).id, 1);
    assert.equal(cog.getImageByResolution(getResolution(17)).id, 0);
    assert.equal(cog.getImageByResolution(getResolution(18)).id, 0);

    for (let i = 19; i < 32; i++) {
      assert.equal(cog.getImageByResolution(getResolution(i)).id, 0);
    }
  });

  it('should get origin from all images', () => {
    const baseOrigin = cog.images[0].origin;
    for (const img of cog.images) {
      assert.deepEqual(img.origin, baseOrigin);
    }
  });

  it('should get bounding box from all images', () => {
    const baseOrigin = cog.images[0].bbox;
    for (const img of cog.images) {
      assert.deepEqual(img.bbox, baseOrigin);
    }
  });

  it('should be geolocated', () => {
    for (const img of cog.images) assert.equal(img.isGeoLocated, true);
  });

  it('should scale image resolution for all images', () => {
    const [resX, resY, resZ] = cog.images[0].resolution;
    for (let i = 0; i < cog.images.length; i++) {
      const img = cog.images[i];
      const scale = 2 ** i; // This tiff is scaled at a factor of two per zoom level
      assert.deepEqual(img.resolution, [resX * scale, resY * scale, resZ]);
    }
  });

  it('should have tile information', () => {
    const [firstImage] = cog.images;
    assert.equal(firstImage.stripCount, 0);
    assert.equal(firstImage.isTiled(), true);
  });

  it('should hasTile for every tile', async () => {
    const [firstImage] = cog.images;

    for (let x = 0; x < firstImage.tileCount.x; x++) {
      for (let y = 0; y < firstImage.tileCount.y; y++) {
        assert.equal(await firstImage.hasTile(x, y), true);
      }
    }
  });
});

describe('Cog.Big', () => {
  it('should support reading from memory', async () => {
    const fullSource = new TestFileSource(new URL('../../data/sparse.tiff', import.meta.url));

    const cog = new CogTiff(fullSource);
    await cog.init();

    const [firstImage] = cog.images;
    assert.equal(firstImage.stripCount, 0);
    assert.equal(firstImage.isTiled(), true);

    const img = cog.images[4];
    assert.deepEqual(img.tileCount, { x: 2, y: 2 });
  });

  it('should read using a memory source', async () => {
    const bytes = await fs.readFile(new URL('../../data/sparse.tiff', import.meta.url));
    const source = new SourceMemory(bytes.buffer);
    const cog = new CogTiff(source);
    await cog.init();

    const [firstImage] = cog.images;
    assert.equal(firstImage.stripCount, 0);
    assert.equal(firstImage.isTiled(), true);

    const img = cog.images[4];
    assert.deepEqual(img.tileCount, { x: 2, y: 2 });
  });
});

describe('Cog.Sparse', () => {
  const cogSourceFile = new TestFileSource(new URL('../../data/sparse.tiff', import.meta.url));
  const cog = new CogTiff(cogSourceFile);

  it('should read metadata', async () => {
    await cog.init();
    assert.equal(cog.images[0].epsg, 2193);
  });

  it('should be geolocated', () => {
    for (const img of cog.images) assert.equal(img.isGeoLocated, true);
  });

  it('should support sparse cogs', async () => {
    const z = 4;
    const img = cog.images[z];

    const { tileCount } = img;
    assert.deepEqual(tileCount, { x: 2, y: 2 });

    for (let x = 0; x < tileCount.x; x++) {
      for (let y = 0; y < tileCount.y; y++) {
        const hasTile = await img.hasTile(x, y);
        assert.equal(hasTile, false);
        const tileXy = await img.getTile(x, y);
        const tileXyz = await cog.images[z].getTile(x, y);
        assert.equal(tileXy, null, `Tile x:${x} y:${y} should be empty`);
        assert.equal(tileXyz, null, `Tile x:${x} y:${y} z: ${z} should be empty`);
      }
    }
  });

  it('should have ghost options', () => {
    assert.equal(cog.options?.options.size, 6);
    assert.equal(cog.options?.tileLeaderByteSize, ByteSize.UInt32);
    assert.equal(cog.options?.isCogOptimized, true);

    const entries = [...(cog.options?.options.entries() ?? [])];
    assert.deepEqual(entries, [
      ['GDAL_STRUCTURAL_METADATA_SIZE', '000140 bytes'],
      ['LAYOUT', 'IFDS_BEFORE_DATA'],
      ['BLOCK_ORDER', 'ROW_MAJOR'],
      ['BLOCK_LEADER', 'SIZE_AS_UINT4'],
      ['BLOCK_TRAILER', 'LAST_4_BYTES_REPEATED'],
      ['KNOWN_INCOMPATIBLE_EDITION', 'NO'],
    ]);
  });
});

describe('CogStrip', () => {
  const cogSourceFile = new TestFileSource(new URL('../../data/rgba8_strip.tiff', import.meta.url));
  const cog = new CogTiff(cogSourceFile);

  beforeEach(() => cog.init());

  it('should get origin from all images', () => {
    const baseOrigin = cog.images[0].origin;
    for (const img of cog.images) {
      assert.deepEqual(img.origin, baseOrigin);
    }
  });

  it('should get bounding box from all images', () => {
    const baseOrigin = cog.images[0].bbox;
    for (const img of cog.images) {
      assert.deepEqual(img.bbox, baseOrigin);
    }
  });

  it('should scale image resolution for all images', () => {
    const [resX, resY, resZ] = cog.images[0].resolution;
    for (let i = 0; i < cog.images.length; i++) {
      const img = cog.images[i];
      const scale = 2 ** i; // This tiff is scaled at a factor of two per zoom level
      assert.deepEqual(img.resolution, [resX * scale, resY * scale, resZ]);
    }
  });

  it('should have strip information', async () => {
    const [firstImage] = cog.images;
    assert.equal(firstImage.isTiled(), false);
    assert.equal(firstImage.stripCount, 2);

    const stripA = await firstImage.getStrip(0);
    assert.equal(stripA?.mimeType, TiffMimeType.Webp);
    assert.equal(stripA?.bytes.byteLength, 152);

    const stripB = await firstImage.getStrip(1);
    assert.equal(stripB?.mimeType, TiffMimeType.Webp);
    assert.equal(stripB?.bytes.byteLength, 152);
  });
});

/** Wraps a source and records every fetch call for assertions */
class CountingSource implements Source {
  url: URL;
  inner: Source;
  fetches: Array<{ offset: number; length?: number }> = [];
  constructor(inner: Source) {
    this.inner = inner;
    this.url = inner.url;
  }
  get metadata(): Source['metadata'] {
    return this.inner.metadata;
  }
  async fetch(offset: number, length?: number): Promise<ArrayBuffer> {
    this.fetches.push({ offset, length });
    return this.inner.fetch(offset, length as number);
  }
}

describe('CogTiffImage.preload', () => {
  it('should load TileOffsets and TileByteCounts for a tiled cog', async () => {
    const source = new TestFileSource(new URL('../../data/rgba8_tiled.tiff', import.meta.url));
    const cog = await CogTiff.create(source);
    const img = cog.images[0];

    const offsets = img.tags.get(TiffTag.TileOffsets) as TagOffset;
    const byteCounts = img.tags.get(TiffTag.TileByteCounts) as TagOffset;
    assert.equal(offsets.type, 'offset');
    assert.equal(byteCounts.type, 'offset');

    await img.preload();

    assert.equal(offsets.isLoaded, true);
    assert.equal(byteCounts.isLoaded, true);
    assert.equal(offsets.value.length, offsets.count);
    assert.equal(byteCounts.value.length, byteCounts.count);
  });

  it('should load TileByteCounts even when a GDAL block leader is present', async () => {
    const source = new TestFileSource(new URL('../../data/sparse.tiff', import.meta.url));
    const cog = await CogTiff.create(source);
    assert.equal(cog.options?.tileLeaderByteSize, ByteSize.UInt32);

    const img = cog.images[0];
    const offsets = img.tags.get(TiffTag.TileOffsets) as TagOffset;
    const byteCounts = img.tags.get(TiffTag.TileByteCounts) as TagOffset;

    await img.preload();

    assert.equal(offsets.isLoaded, true);
    assert.equal(byteCounts.isLoaded, true);
  });

  it('should load StripOffsets and StripByteCounts for a striped cog', async () => {
    const source = new TestFileSource(new URL('../../data/rgba8_strip.tiff', import.meta.url));
    const cog = await CogTiff.create(source);
    const img = cog.images[0];
    assert.equal(img.isTiled(), false);

    const offsets = img.tags.get(TiffTag.StripOffsets) as TagOffset;
    const byteCounts = img.tags.get(TiffTag.StripByteCounts) as TagOffset;

    await img.preload();

    assert.equal(offsets.isLoaded, true);
    assert.equal(byteCounts.isLoaded, true);
  });

  it('should be idempotent', async () => {
    const source = new TestFileSource(new URL('../../data/rgba8_tiled.tiff', import.meta.url));
    const cog = await CogTiff.create(source);
    const img = cog.images[0];

    await img.preload();
    await img.preload();

    const offsets = img.tags.get(TiffTag.TileOffsets) as TagOffset;
    assert.equal(offsets.isLoaded, true);
  });

  it('should avoid per-tile offset fetches for subsequent getTile calls', async () => {
    const inner = new TestFileSource(new URL('../../data/rgba8_tiled.tiff', import.meta.url));
    const counter = new CountingSource(inner);
    const cog = await CogTiff.create(counter);
    const img = cog.images[0];

    const offsets = img.tags.get(TiffTag.TileOffsets) as TagOffset;
    const byteCounts = img.tags.get(TiffTag.TileByteCounts) as TagOffset;
    const offsetRange = { start: offsets.dataOffset, end: offsets.dataOffset + offsets.count * 8 };
    const byteRange = { start: byteCounts.dataOffset, end: byteCounts.dataOffset + byteCounts.count * 8 };

    await img.preload();
    counter.fetches.length = 0;

    const { tileCount } = img;
    for (let x = 0; x < tileCount.x; x++) {
      for (let y = 0; y < tileCount.y; y++) {
        await img.getTile(x, y);
      }
    }

    // No fetch after preload should overlap with the tile index arrays
    for (const f of counter.fetches) {
      const end = f.offset + (f.length ?? 0);
      const overlapsOffsets = f.offset < offsetRange.end && end > offsetRange.start;
      const overlapsByteCounts = f.offset < byteRange.end && end > byteRange.start;
      assert.equal(overlapsOffsets, false, `fetch ${f.offset}+${f.length} overlaps TileOffsets`);
      assert.equal(overlapsByteCounts, false, `fetch ${f.offset}+${f.length} overlaps TileByteCounts`);
    }
  });

  it('should avoid per-tile leader fetches on a GDAL-optimized cog after preload', async () => {
    const inner = new TestFileSource(new URL('../../data/sparse.tiff', import.meta.url));
    const counter = new CountingSource(inner);
    const cog = await CogTiff.create(counter);
    const leaderBytes = cog.options?.tileLeaderByteSize;
    assert.equal(leaderBytes, ByteSize.UInt32);
    const img = cog.images[0];

    await img.preload();
    counter.fetches.length = 0;

    const { tileCount } = img;
    for (let x = 0; x < tileCount.x; x++) {
      for (let y = 0; y < tileCount.y; y++) {
        await img.getTileSize(y * tileCount.x + x);
      }
    }

    // A leader fetch is identifiable as a request of exactly leaderBytes
    for (const f of counter.fetches) {
      assert.notEqual(f.length, leaderBytes, `unexpected leader-sized fetch @ ${f.offset}+${f.length}`);
    }
  });

  it('should avoid per-tile leader fetches even without an explicit preload', async () => {
    const inner = new TestFileSource(new URL('../../data/sparse.tiff', import.meta.url));
    const counter = new CountingSource(inner);
    const cog = await CogTiff.create(counter);
    const leaderBytes = cog.options?.tileLeaderByteSize;
    assert.equal(leaderBytes, ByteSize.UInt32);
    const img = cog.images[0];

    counter.fetches.length = 0;

    const { tileCount } = img;
    for (let x = 0; x < tileCount.x; x++) {
      for (let y = 0; y < tileCount.y; y++) {
        await img.getTileSize(y * tileCount.x + x);
      }
    }

    // A leader fetch is identifiable as a request of exactly leaderBytes
    for (const f of counter.fetches) {
      assert.notEqual(f.length, leaderBytes, `unexpected leader-sized fetch @ ${f.offset}+${f.length}`);
    }
  });
});
