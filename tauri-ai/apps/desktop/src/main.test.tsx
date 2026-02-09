import { describe, it, expect } from 'vitest';
import * as pdfjsLib from 'pdfjs-dist';

describe('PDF.js Worker Configuration', () => {
  it('应该正确配置 GlobalWorkerOptions.workerSrc', () => {
    // 验证 workerSrc 已被设置
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBeDefined();
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).not.toBe('');
    
    // 验证 workerSrc 包含正确的路径
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toContain('pdf.worker');
  });

  it('应该使用本地 worker 文件而不是 CDN', () => {
    const workerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc;
    
    // 验证不是使用 CDN
    expect(workerSrc).not.toContain('cdnjs.cloudflare.com');
    
    // 验证使用的是本地 worker 文件（在测试环境中会被解析为相对路径）
    expect(workerSrc).toContain('pdf.worker');
  });
});
