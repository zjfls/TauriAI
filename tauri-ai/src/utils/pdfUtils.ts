/**
 * PDF Utilities
 * Functions for validating and processing PDF files
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */

/**
 * Maximum PDF file size (20MB)
 * Requirement: 1.5
 */
export const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Check if a file is a valid PDF file
 * Validates both file extension and MIME type
 * 
 * Requirements: 1.1, 1.2, 1.3
 * 
 * @param file - The File object to validate
 * @returns true if the file is a valid PDF, false otherwise
 */
export function isValidPdfFile(file: File): boolean {
  if (!file || !(file instanceof File)) {
    return false;
  }
  
  // Check file extension (case-insensitive)
  const filename = file.name.toLowerCase();
  const hasValidExtension = filename.endsWith('.pdf');
  
  // Check MIME type
  const hasValidMimeType = file.type === 'application/pdf';
  
  // Both extension and MIME type should match
  return hasValidExtension && hasValidMimeType;
}

/**
 * Validate PDF file size against the maximum limit
 * 
 * Requirements: 1.3, 1.5
 * 
 * @param file - The File object to validate
 * @returns true if the file size is within the limit (<= 20MB), false otherwise
 */
export function validatePdfSize(file: File): boolean {
  if (!file || !(file instanceof File)) {
    return false;
  }
  
  return file.size <= MAX_PDF_SIZE;
}

/**
 * Error messages for PDF processing failures
 */
export const PDF_ERROR_MESSAGES = {
  INVALID_TYPE: '只支持 PDF 文件',
  TOO_LARGE: `PDF 文件过大，请选择小于 ${MAX_PDF_SIZE / 1024 / 1024}MB 的文件`,
  TOO_MANY_PAGES: (maxPages: number) => `PDF 页数过多，最多支持 ${maxPages} 页`,
  CORRUPTED: 'PDF 文件损坏，无法读取',
  ENCRYPTED: 'PDF 文件受密码保护，请提供无密码保护的版本',
  TEXT_EXTRACTION_FAILED: '文本提取失败，将仅使用页面图像',
  IMAGE_GENERATION_FAILED: '页面图像生成失败',
  PROCESSING_TIMEOUT: 'PDF 处理超时，请尝试较小的文件',
  GENERIC_ERROR: (error: string) => `PDF 处理失败: ${error}`,
} as const;

/**
 * JPEG quality for page image compression (0.0 - 1.0)
 * Requirement: 9.2
 */
export const PDF_IMAGE_QUALITY = 0.85;

/**
 * Clean up canvas resources to free memory
 * Clears the canvas and releases context resources
 * 
 * Requirement: 9.6
 * 
 * @param canvas - The canvas element to clean up
 */
export function cleanupCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (context) {
    // Clear the canvas
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  // Reset canvas dimensions to free memory
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Compress a canvas to JPEG format with quality parameter
 * Balances image quality and file size
 * 
 * Requirement: 9.2
 * 
 * @param canvas - The canvas element to compress
 * @param quality - JPEG quality (0.0 - 1.0, default: 0.85)
 * @returns Base64 data URL of the compressed JPEG image
 */
export function compressPageImage(
  canvas: HTMLCanvasElement,
  quality: number = PDF_IMAGE_QUALITY
): string {
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Extract content from a single PDF page
 * Extracts both text content and renders the page as an image
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 9.2
 * 
 * @param page - PDF.js page proxy object
 * @param pageNumber - Page number (1-indexed)
 * @param scale - Rendering scale factor (default: 2.0 for high quality)
 * @returns Promise resolving to PdfPage with text and image data
 * @throws Error if text extraction or image rendering fails
 */
export async function extractPageContent(
  page: any, // PDFPageProxy from pdfjs-dist
  pageNumber: number,
  scale: number = 2.0
): Promise<{ pageNumber: number; text: string; image: string }> {
  // Extract text content (Requirement 3.1)
  let text = '';
  try {
    const textContent = await page.getTextContent();
    text = textContent.items
      .map((item: any) => item.str)
      .join(' ')
      .trim();
  } catch (textError) {
    console.warn(`${PDF_ERROR_MESSAGES.TEXT_EXTRACTION_FAILED} (page ${pageNumber}):`, textError);
    // Continue with empty text if extraction fails (Requirement 10.3)
    text = '';
  }

  // Render page to canvas (Requirements 3.2, 3.3)
  let canvas: HTMLCanvasElement | null = null;
  try {
    const viewport = page.getViewport({ scale });
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    if (!context) {
      throw new Error(PDF_ERROR_MESSAGES.IMAGE_GENERATION_FAILED);
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Render the page
    const renderContext = {
      canvasContext: context,
      viewport: viewport,
    };

    await page.render(renderContext).promise;

    // Compress canvas to JPEG format (Requirement 9.2)
    const image = compressPageImage(canvas, PDF_IMAGE_QUALITY);

    // Clean up canvas resources (Requirement 9.6)
    cleanupCanvas(canvas);

    return {
      pageNumber,
      text,
      image,
    };
  } catch (error) {
    // Clean up canvas on error (Requirement 9.6)
    if (canvas) {
      cleanupCanvas(canvas);
    }
    
    // Handle image generation failure (Requirement 10.4)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === PDF_ERROR_MESSAGES.IMAGE_GENERATION_FAILED) {
      throw new Error(errorMessage);
    }
    throw new Error(`${PDF_ERROR_MESSAGES.IMAGE_GENERATION_FAILED}: ${errorMessage}`);
  }
}

/**
 * Processing timeout in milliseconds (30 seconds)
 */
const PROCESSING_TIMEOUT = 30000;

/**
 * Process a PDF file and extract all pages
 * Loads the PDF, validates page count, extracts metadata, and processes pages in batches
 * 
 * Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 9.1, 9.3, 10.1-10.7
 * 
 * @param file - The PDF File object to process
 * @param onProgress - Optional callback to report processing progress (0-100)
 * @returns Promise resolving to PendingPdf object with all extracted data
 * @throws Error if PDF loading fails, page count exceeds limit, or processing fails
 */
export async function processPdfFile(
  file: File,
  onProgress?: (progress: number) => void
): Promise<{
  id: string;
  filename: string;
  size: number;
  pages: Array<{ pageNumber: number; text: string; image: string }>;
  totalPages: number;
  metadata?: {
    title?: string;
    author?: string;
    createdAt?: string;
    producer?: string;
    subject?: string;
    keywords?: string;
  };
  processingProgress: number;
}> {
  // Import pdfjs-dist dynamically
  const pdfjsLib = await import('pdfjs-dist');
  
  // Configure worker (Requirement 3.1)
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  }

  // Create timeout promise (Requirement 10.5)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(PDF_ERROR_MESSAGES.PROCESSING_TIMEOUT));
    }, PROCESSING_TIMEOUT);
  });

  try {
    // Race between processing and timeout
    return await Promise.race([
      processPdfFileInternal(file, pdfjsLib, onProgress),
      timeoutPromise
    ]);
  } catch (error) {
    // Handle specific PDF errors (Requirement 10.1-10.7)
    if (error instanceof Error) {
      // Check for timeout
      if (error.message === PDF_ERROR_MESSAGES.PROCESSING_TIMEOUT) {
        throw error;
      }
      
      // Check for encrypted PDF
      if (error.message.includes('password') || error.message.includes('encrypted')) {
        throw new Error(PDF_ERROR_MESSAGES.ENCRYPTED);
      }
      
      // Check for corrupted PDF
      if (error.message.includes('Invalid PDF') || error.message.includes('corrupted')) {
        throw new Error(PDF_ERROR_MESSAGES.CORRUPTED);
      }

      // Re-throw if it's already one of our error messages
      if (Object.values(PDF_ERROR_MESSAGES).some(msg => 
        typeof msg === 'string' && error.message === msg
      )) {
        throw error;
      }

      // Generic error
      throw new Error(PDF_ERROR_MESSAGES.GENERIC_ERROR(error.message));
    }

    throw new Error(PDF_ERROR_MESSAGES.GENERIC_ERROR(String(error)));
  }
}

/**
 * Internal function to process PDF file
 * Separated to allow timeout handling in the main function
 */
async function processPdfFileInternal(
  file: File,
  pdfjsLib: any,
  onProgress?: (progress: number) => void
): Promise<{
  id: string;
  filename: string;
  size: number;
  pages: Array<{ pageNumber: number; text: string; image: string }>;
  totalPages: number;
  metadata?: {
    title?: string;
    author?: string;
    createdAt?: string;
    producer?: string;
    subject?: string;
    keywords?: string;
  };
  processingProgress: number;
}> {
  let pdf: any = null;
  
  try {
    // Load PDF document (Requirement 3.1)
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdf = await loadingTask.promise;

    // Validate page count (Requirement 3.5, 9.1)
    const MAX_PDF_PAGES = 50;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(PDF_ERROR_MESSAGES.TOO_MANY_PAGES(MAX_PDF_PAGES));
    }

    const totalPages = pdf.numPages;

    // Extract document metadata (Requirement 3.6, 3.7)
    let metadata: {
      title?: string;
      author?: string;
      createdAt?: string;
      producer?: string;
      subject?: string;
      keywords?: string;
    } | undefined;

    try {
      const pdfMetadata = await pdf.getMetadata();
      const info = pdfMetadata.info as any;
      
      metadata = {
        title: info?.Title || undefined,
        author: info?.Author || undefined,
        createdAt: info?.CreationDate || undefined,
        producer: info?.Producer || undefined,
        subject: info?.Subject || undefined,
        keywords: info?.Keywords || undefined,
      };

      // Remove undefined fields
      metadata = Object.fromEntries(
        Object.entries(metadata).filter(([_, v]) => v !== undefined)
      ) as typeof metadata;

      // If no metadata fields, set to undefined
      if (Object.keys(metadata).length === 0) {
        metadata = undefined;
      }
    } catch (metadataError) {
      console.warn('Failed to extract PDF metadata:', metadataError);
      metadata = undefined;
    }

    // Process pages in batches (Requirement 9.1, 9.3)
    const BATCH_SIZE = 5;
    const PDF_IMAGE_SCALE = 2.0;
    const pages: Array<{ pageNumber: number; text: string; image: string }> = [];

    for (let i = 0; i < totalPages; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, totalPages);
      const batch: Promise<{ pageNumber: number; text: string; image: string }>[] = [];

      // Create batch of page extraction promises
      for (let j = i; j < batchEnd; j++) {
        const pageNumber = j + 1;
        batch.push(
          pdf.getPage(pageNumber).then(page => 
            extractPageContent(page, pageNumber, PDF_IMAGE_SCALE)
          )
        );
      }

      // Process batch in parallel
      const batchResults = await Promise.all(batch);
      pages.push(...batchResults);

      // Update progress (Requirement 9.1)
      const progress = Math.round((pages.length / totalPages) * 100);
      onProgress?.(progress);

      // Yield control to avoid blocking UI (Requirement 9.3)
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Generate unique ID
    const id = `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const result = {
      id,
      filename: file.name,
      size: file.size,
      pages,
      totalPages,
      metadata,
      processingProgress: 100,
    };

    // Clean up PDF object (Requirement 9.6)
    if (pdf && pdf.cleanup) {
      await pdf.cleanup();
    }
    if (pdf && pdf.destroy) {
      await pdf.destroy();
    }

    return result;
  } catch (error) {
    // Clean up PDF object on error (Requirement 9.6)
    if (pdf) {
      try {
        if (pdf.cleanup) {
          await pdf.cleanup();
        }
        if (pdf.destroy) {
          await pdf.destroy();
        }
      } catch (cleanupError) {
        console.warn('Failed to clean up PDF object:', cleanupError);
      }
    }
    
    // Re-throw errors to be handled by the main processPdfFile function
    throw error;
  }
}

/**
 * Estimate the number of tokens required for a PDF document
 * Calculates token usage for both text content and images
 * 
 * Requirement: 9.4
 * 
 * Token estimation:
 * - Text: ~1 token per 4 characters (rough estimate for English/Chinese)
 * - Images: ~765 tokens per image (OpenAI high detail pricing)
 * 
 * @param pdf - The PendingPdf object to estimate tokens for
 * @returns Estimated total token count
 */
export function estimatePdfTokens(pdf: {
  pages: Array<{ pageNumber: number; text: string; image: string }>;
}): number {
  let tokens = 0;

  for (const page of pdf.pages) {
    // Text tokens (rough estimate: 1 token ≈ 4 characters)
    // This is a conservative estimate that works reasonably well for both English and Chinese
    tokens += Math.ceil(page.text.length / 4);

    // Image tokens (OpenAI high detail pricing)
    // According to OpenAI documentation, high detail images cost approximately 765 tokens
    tokens += 765;
  }

  return tokens;
}
