# 3DGS PLY to 3D Tiles Converter Website

Browser-only interface for converting Gaussian Splatting PLY files to 3D Tiles or simplifying them into smaller PLY files. Model data stays in the browser tab and is never uploaded.

Conversion is provided by the published `3dgs-ply-3dtiles-converter/browser` API.

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
