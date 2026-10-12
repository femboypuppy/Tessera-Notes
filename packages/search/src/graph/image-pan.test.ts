import { describe, expect, it } from 'vitest';
import { ImagePan, isSoftwareRenderer } from './image-pan';

describe('isSoftwareRenderer', () => {
  it('recognizes the renderers that draw WebGL on the CPU', () => {
    for (const name of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Mesa/X.org, llvmpipe (LLVM 17.0.6, 256 bits)',
      'softpipe',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ]) {
      expect(isSoftwareRenderer(name), name).toBe(true);
    }
  });

  it('leaves graphics cards and unknown renderers alone', () => {
    for (const name of [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Apple M2',
      'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
      'WebKit WebGL',
      '',
      null,
    ]) {
      expect(isSoftwareRenderer(name), String(name)).toBe(false);
    }
  });
});

function layers(count: number): HTMLElement[] {
  return Array.from({ length: count }, () => document.createElement('canvas'));
}

describe('ImagePan', () => {
  it('moves every layer with the pointer, without redrawing', () => {
    const drawn = layers(3);
    const pan = new ImagePan(() => drawn);
    pan.begin({ x: 100, y: 50 });
    expect(pan.active).toBe(true);
    pan.move({ x: 130, y: 40 });
    pan.move({ x: 160, y: 20 });
    for (const layer of drawn) expect(layer.style.transform).toBe('translate(60px, -30px)');
  });

  it('reports where the pointer started and ended, and keeps the image in place until cleared', () => {
    const drawn = layers(2);
    const pan = new ImagePan(() => drawn);
    pan.begin({ x: 10, y: 10 });
    pan.move({ x: 25, y: 4 });
    expect(pan.end()).toEqual({ from: { x: 10, y: 10 }, to: { x: 25, y: 4 } });
    expect(pan.active).toBe(false);
    // The moved image stays until the graph is redrawn at its new position.
    for (const layer of drawn) expect(layer.style.transform).toBe('translate(15px, -6px)');
    pan.clear();
    for (const layer of drawn) expect(layer.style.transform).toBe('');
  });

  it('reports nothing for a press that did not move (a click)', () => {
    const drawn = layers(1);
    const pan = new ImagePan(() => drawn);
    pan.begin({ x: 10, y: 10 });
    expect(pan.end()).toBeNull();
    pan.begin({ x: 10, y: 10 });
    pan.move({ x: 10, y: 10 });
    expect(pan.end()).toBeNull();
    expect(drawn[0]?.style.transform).toBe('');
  });

  it('ignores moves and releases outside a pan', () => {
    const drawn = layers(1);
    const pan = new ImagePan(() => drawn);
    pan.move({ x: 40, y: 40 });
    expect(pan.end()).toBeNull();
    expect(drawn[0]?.style.transform).toBe('');
  });

  it('a new pan starts from the redrawn image', () => {
    const drawn = layers(1);
    const pan = new ImagePan(() => drawn);
    pan.begin({ x: 0, y: 0 });
    pan.move({ x: 20, y: 0 });
    pan.end();
    pan.clear();
    pan.begin({ x: 50, y: 50 });
    pan.move({ x: 45, y: 60 });
    expect(drawn[0]?.style.transform).toBe('translate(-5px, 10px)');
  });
});
