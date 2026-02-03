/**
 * Audio transcription utility using local Whisper CLI
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  duration?: number;
}

/**
 * Transcribe audio buffer using local Whisper CLI
 */
export async function transcribeAudio(
  buffer: Buffer,
  format: string,
  language?: string
): Promise<TranscriptionResult> {
  // Check if whisper is available
  const whisperPath = findWhisperBinary();
  if (!whisperPath) {
    return {
      success: false,
      error: 'Local Whisper CLI not installed. Run: pip install openai-whisper',
    };
  }

  const tmpDir = os.tmpdir();
  const tmpAudioPath = path.join(tmpDir, `whisper-input-${Date.now()}.${format}`);
  const tmpOutputDir = path.join(tmpDir, `whisper-output-${Date.now()}`);

  try {
    // Write audio buffer to temp file
    await fs.promises.writeFile(tmpAudioPath, buffer);
    await fs.promises.mkdir(tmpOutputDir, { recursive: true });

    const startTime = Date.now();

    // Build whisper command args
    const args = [
      tmpAudioPath,
      '--model', 'base', // Use base model for speed (can be changed to small/medium/large)
      '--output_dir', tmpOutputDir,
      '--output_format', 'txt',
    ];

    if (language) {
      args.push('--language', language);
    }

    // Run whisper
    await execFileAsync(whisperPath, args, {
      timeout: 120000, // 2 minute timeout
    });

    const duration = (Date.now() - startTime) / 1000;

    // Read the output text file
    const baseName = path.basename(tmpAudioPath, `.${format}`);
    const outputPath = path.join(tmpOutputDir, `${baseName}.txt`);

    if (!fs.existsSync(outputPath)) {
      return {
        success: false,
        error: 'Whisper did not produce output file',
      };
    }

    const text = (await fs.promises.readFile(outputPath, 'utf-8')).trim();

    // Cleanup
    await cleanup(tmpAudioPath, tmpOutputDir);

    return {
      success: true,
      text,
      duration,
    };
  } catch (error) {
    // Cleanup on error
    await cleanup(tmpAudioPath, tmpOutputDir);

    console.error('[Transcribe] Error:', error);

    if (error instanceof Error) {
      if (error.message.includes('ENOENT')) {
        return {
          success: false,
          error: 'Whisper binary not found. Install with: pip install openai-whisper',
        };
      }
      if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
        return {
          success: false,
          error: 'Transcription timed out. Try a shorter audio clip.',
        };
      }
      return {
        success: false,
        error: `Transcription failed: ${error.message}`,
      };
    }

    return {
      success: false,
      error: 'Unknown transcription error',
    };
  }
}

/**
 * Find the whisper binary path
 */
function findWhisperBinary(): string | null {
  try {
    const result = execSync('which whisper', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // Not found in PATH
  }

  // Check common locations
  const commonPaths = [
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper',
    path.join(os.homedir(), '.local/bin/whisper'),
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Check if voice transcription is available (local whisper installed)
 */
export function isTranscriptionAvailable(): boolean {
  try {
    execSync('which whisper', { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleanup temporary files
 */
async function cleanup(audioPath: string, outputDir: string): Promise<void> {
  try {
    if (fs.existsSync(audioPath)) {
      await fs.promises.unlink(audioPath);
    }
    if (fs.existsSync(outputDir)) {
      const files = await fs.promises.readdir(outputDir);
      for (const file of files) {
        await fs.promises.unlink(path.join(outputDir, file));
      }
      await fs.promises.rmdir(outputDir);
    }
  } catch {
    // Ignore cleanup errors
  }
}
