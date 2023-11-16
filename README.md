# @maxar/cogeotiff-core

This is a fork of https://github.com/blacha/cogeotiff (https://github.com/blacha/cogeotiff/tree/master/packages/core) with
a couple of very specific tweaks for handling direct loading of the TIFF header and exact tiles to limit requests to
the remote resource. 


___All credit, and a big shout out, goes to Blayne Chard .___



>
> Working with [Cloud optimized GEOTiff](https://www.cogeo.org/)
>
>-  Completely javascript based, works in the browser and nodejs
>-  Lazy load COG images and metadata
>-  Supports huge 100GB+ COGs
>-  Uses GDAL COG optimizations, generally only one or two reads per tile!

## Usage

Load a COG from a remote http source

```typescript
import { SourceHttp } from '@chunkd/source-url';
import { CogTiff } from '@maxar/cogeotiff-core'

const source = new SourceHttp('https://example.com/cog.tif');
const tiff = await CogTiff.create(source);

/** Load a specific tile from a specific image */
const tile = await tiff.images[5].getTile(2, 2);

/** Load the 5th image in the Tiff */
const img = tiff.images[5];
if (img.isTiled()) {
    /** Load tile x:10 y:10 */
    const tile = await img.getTile(10, 10);
    tile.mimeType; // image/jpeg
    tile.bytes; // Raw image buffer
}

/** Get the origin point of the tiff */
const origin = img.origin;
/** Bounding box of the tiff */
const bbox = img.bbox;
```


More information and examples can be seen @

- [@cogeotiff](https://github.com/blacha/cogeotiff