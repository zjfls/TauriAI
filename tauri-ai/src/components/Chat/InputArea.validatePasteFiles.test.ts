/**
 * Unit tests for validatePasteFiles function
 * Requirements: 2.2, 6.1, 6.2, 6.3, 6.4
 */

import { describe, it, expect } from 'vitest';
import { validatePasteFiles } from './InputArea';

// Helper to create mock File objects
const createMockFile = (name: string, type: string, size: number = 1024): File => {
  return new File(['test content'], name, { type });
};

describe('validatePasteFiles', () => {
  describe('图片文件验证', () => {
    it('当 supportsVision 为 false 时应拒绝所有图片', () => {
      const imageFiles = [
        createMockFile('test1.jpg', 'image/jpeg'),
        createMockFile('test2.png', 'image/png'),
      ];
      
      const result = validatePasteFiles(
        imageFiles,
        [],
        [],
        0,
        0,
        0,
        false // supportsVision = false
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.imageFiles).toHaveLength(0);
      expect(result.errors).toContain('当前模型不支持图片');
    });

    it('当图片数量已达上限时应拒绝新图片', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      
      const result = validatePasteFiles(
        imageFiles,
        [],
        [],
        10, // 当前已有 10 张图片（达到上限）
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.imageFiles).toHaveLength(0);
      expect(result.errors).toContain('图片数量已达上限');
    });

    it('当图片数量超过剩余槽位时应只接受部分图片', () => {
      const imageFiles = [
        createMockFile('test1.jpg', 'image/jpeg'),
        createMockFile('test2.jpg', 'image/jpeg'),
        createMockFile('test3.jpg', 'image/jpeg'),
      ];
      
      const result = validatePasteFiles(
        imageFiles,
        [],
        [],
        8, // 当前已有 8 张图片，剩余 2 个槽位
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.imageFiles).toHaveLength(2); // 只接受 2 张
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('图片数量超过限制');
    });

    it('当图片数量在限制内时应接受所有图片', () => {
      const imageFiles = [
        createMockFile('test1.jpg', 'image/jpeg'),
        createMockFile('test2.jpg', 'image/jpeg'),
      ];
      
      const result = validatePasteFiles(
        imageFiles,
        [],
        [],
        5, // 当前已有 5 张图片，剩余 5 个槽位
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.imageFiles).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('文本文件验证', () => {
    it('当文本文件数量已达上限时应拒绝新文件', () => {
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      
      const result = validatePasteFiles(
        [],
        textFiles,
        [],
        0,
        5, // 当前已有 5 个文本文件（达到上限）
        0,
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.textFiles).toHaveLength(0);
      expect(result.errors).toContain('文本文件数量已达上限');
    });

    it('当文本文件数量超过剩余槽位时应只接受部分文件', () => {
      const textFiles = [
        createMockFile('test1.txt', 'text/plain'),
        createMockFile('test2.txt', 'text/plain'),
        createMockFile('test3.txt', 'text/plain'),
      ];
      
      const result = validatePasteFiles(
        [],
        textFiles,
        [],
        0,
        3, // 当前已有 3 个文本文件，剩余 2 个槽位
        0,
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.textFiles).toHaveLength(2); // 只接受 2 个
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('文本文件数量超过限制');
    });

    it('当文本文件数量在限制内时应接受所有文件', () => {
      const textFiles = [
        createMockFile('test1.txt', 'text/plain'),
        createMockFile('test2.txt', 'text/plain'),
      ];
      
      const result = validatePasteFiles(
        [],
        textFiles,
        [],
        0,
        2, // 当前已有 2 个文本文件，剩余 3 个槽位
        0,
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.textFiles).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('PDF 文件验证', () => {
    it('当 PDF 文件数量已达上限时应拒绝新文件', () => {
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        [],
        [],
        pdfFiles,
        0,
        0,
        3, // 当前已有 3 个 PDF（达到上限）
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.pdfFiles).toHaveLength(0);
      expect(result.errors).toContain('PDF 文件数量已达上限');
    });

    it('当 PDF 文件数量超过剩余槽位时应只接受部分文件', () => {
      const pdfFiles = [
        createMockFile('test1.pdf', 'application/pdf'),
        createMockFile('test2.pdf', 'application/pdf'),
        createMockFile('test3.pdf', 'application/pdf'),
      ];
      
      const result = validatePasteFiles(
        [],
        [],
        pdfFiles,
        0,
        0,
        2, // 当前已有 2 个 PDF，剩余 1 个槽位
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.pdfFiles).toHaveLength(1); // 只接受 1 个
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('PDF 文件数量超过限制');
    });

    it('当 PDF 文件数量在限制内时应接受所有文件', () => {
      const pdfFiles = [
        createMockFile('test1.pdf', 'application/pdf'),
        createMockFile('test2.pdf', 'application/pdf'),
      ];
      
      const result = validatePasteFiles(
        [],
        [],
        pdfFiles,
        0,
        0,
        1, // 当前已有 1 个 PDF，剩余 2 个槽位
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.pdfFiles).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('混合文件类型验证', () => {
    it('应同时验证多种文件类型', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        0,
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.imageFiles).toHaveLength(1);
      expect(result.textFiles).toHaveLength(1);
      expect(result.pdfFiles).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('当部分类型超限时应只接受有效的文件', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        10, // 图片已达上限
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(true); // 文本和 PDF 仍可添加
      expect(result.imageFiles).toHaveLength(0); // 图片被拒绝
      expect(result.textFiles).toHaveLength(1);
      expect(result.pdfFiles).toHaveLength(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors).toContain('图片数量已达上限');
    });

    it('当所有类型都超限时应拒绝所有文件', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        10, // 图片已达上限
        5,  // 文本文件已达上限
        3,  // PDF 已达上限
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.imageFiles).toHaveLength(0);
      expect(result.textFiles).toHaveLength(0);
      expect(result.pdfFiles).toHaveLength(0);
      expect(result.errors).toHaveLength(3);
    });
  });

  describe('边界条件', () => {
    it('当没有文件时应返回空结果', () => {
      const result = validatePasteFiles(
        [],
        [],
        [],
        0,
        0,
        0,
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.imageFiles).toHaveLength(0);
      expect(result.textFiles).toHaveLength(0);
      expect(result.pdfFiles).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('当剩余槽位为 0 时应拒绝所有文件', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        10, // 图片槽位已满
        5,  // 文本槽位已满
        3,  // PDF 槽位已满
        true
      );
      
      expect(result.canProceed).toBe(false);
      expect(result.imageFiles).toHaveLength(0);
      expect(result.textFiles).toHaveLength(0);
      expect(result.pdfFiles).toHaveLength(0);
    });

    it('当剩余槽位刚好等于文件数量时应接受所有文件', () => {
      const imageFiles = [createMockFile('test.jpg', 'image/jpeg')];
      const textFiles = [createMockFile('test.txt', 'text/plain')];
      const pdfFiles = [createMockFile('test.pdf', 'application/pdf')];
      
      const result = validatePasteFiles(
        imageFiles,
        textFiles,
        pdfFiles,
        9, // 剩余 1 个图片槽位
        4, // 剩余 1 个文本槽位
        2, // 剩余 1 个 PDF 槽位
        true
      );
      
      expect(result.canProceed).toBe(true);
      expect(result.imageFiles).toHaveLength(1);
      expect(result.textFiles).toHaveLength(1);
      expect(result.pdfFiles).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });
  });
});
