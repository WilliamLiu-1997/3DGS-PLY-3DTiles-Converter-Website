# 3DGS PLY to 3D Tiles Converter Website

![3DGS PLY to 3D Tiles Converter](https://raw.githubusercontent.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter/main/3DGS-PLY-3DTiles-Converter.png)

Browser-only interface for converting Gaussian Splatting PLY files to 3D Tiles or simplifying them into smaller PLY files. Model data stays in the browser tab and is never uploaded.

Conversion is provided by the published [`3dgs-ply-3dtiles-converter/browser`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter) API.
Interactive PLY and generated 3D Tiles previews are rendered with [`gaussian-splat-lite`](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) and [`3d-tiles-rendererjs-3dgs-plugin`](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin).

## Local development

Requirements:

- Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The published converter package contains its browser entry and Worker. No sibling converter checkout or local converter build is required.

## Production build

```bash
npm run build
npm start
```

The site uses standard Next.js App Router commands with webpack. Conversion calls only the package's `convert` and `simplify` functions; the package owns the bundled Blob Worker lifecycle.
