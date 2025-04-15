import * as path from "path"
// @ts-ignore-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import mammoth from "mammoth"
import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"

export async function extractTextFromFile(filePath: string): Promise<string> {
	try {
		await fs.access(filePath)
	} catch (error) {
		throw new Error(`File not found: ${filePath}`)
	}
	const fileExtension = path.extname(filePath).toLowerCase()
	switch (fileExtension) {
		case ".pdf":
			return extractTextFromPDF(filePath)
		case ".docx":
			return extractTextFromDOCX(filePath)
		case ".ipynb":
			return extractTextFromIPYNB(filePath)
		default:
			const isBinary = await isBinaryFile(filePath).catch(() => false)
			if (!isBinary) {
				return addLineNumbers(await fs.readFile(filePath, "utf8"))
			} else {
				throw new Error(`Cannot read text for file type: ${fileExtension}`)
			}
	}
}

async function extractTextFromPDF(filePath: string): Promise<string> {
	const dataBuffer = await fs.readFile(filePath)
	const data = await pdf(dataBuffer)
	return addLineNumbers(data.text)
}

async function extractTextFromDOCX(filePath: string): Promise<string> {
	const result = await mammoth.extractRawText({ path: filePath })
	return addLineNumbers(result.value)
}

async function extractTextFromIPYNB(filePath: string): Promise<string> {
	const data = await fs.readFile(filePath, "utf8")
	const notebook = JSON.parse(data)
	let extractedText = ""

	for (const cell of notebook.cells) {
		if ((cell.cell_type === "markdown" || cell.cell_type === "code") && cell.source) {
			extractedText += cell.source.join("\n") + "\n"
		}
	}

	return addLineNumbers(extractedText)
}

export function addLineNumbers(content: string, startLine: number = 1): string {
	// If content is empty, return empty string - empty files should not have line numbers
	// If content is empty but startLine > 1, return "startLine | " because we know the file is not empty
	// but the content is empty at that line offset
	if (content === "") {
		return startLine === 1 ? "" : `${startLine} | \n`
	}

	// Split into lines and handle trailing newlines
	const lines = content.split("\n")
	const lastLineEmpty = lines[lines.length - 1] === ""
	if (lastLineEmpty) {
		lines.pop()
	}

	const maxLineNumberWidth = String(startLine + lines.length - 1).length
	const numberedContent = lines
		.map((line, index) => {
			const lineNumber = String(startLine + index).padStart(maxLineNumberWidth, " ")
			return `${lineNumber} | ${line}`
		})
		.join("\n")

	return numberedContent + "\n"
}
// Checks if every line in the content has line numbers prefixed (e.g., "1 | content" or "123 | content")
// Line numbers must be followed by a single pipe character (not double pipes)
export function everyLineHasLineNumbers(content: string): boolean {
	const lines = content.split(/\r?\n/)
	return lines.length > 0 && lines.every((line) => /^\s*\d+\s+\|(?!\|)/.test(line))
}

/**
 * Strips line numbers from content while preserving the actual content.
 *
 * @param content The content to process
 * @param aggressive When false (default): Only strips lines with clear number patterns like "123 | content"
 *                   When true: Uses a more lenient pattern that also matches lines with just a pipe character,
 *                   which can be useful when LLMs don't perfectly format the line numbers in diffs
 * @returns The content with line numbers removed
 */
export function stripLineNumbers(content: string, aggressive: boolean = false): string {
	// Split into lines to handle each line individually
	const lines = content.split(/\r?\n/)

	// Process each line
	const processedLines = lines.map((line) => {
		// Match line number pattern and capture everything after the pipe
		const match = aggressive ? line.match(/^\s*(?:\d+\s)?\|\s(.*)$/) : line.match(/^\s*\d+\s+\|(?!\|)\s?(.*)$/)
		return match ? match[1] : line
	})

	// Join back with original line endings
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n"
	return processedLines.join(lineEnding)
}

/**
 * Truncates multi-line output while preserving context from both the beginning and end.
 * When truncation is needed, it keeps 20% of the lines from the start and 80% from the end,
 * with a clear indicator of how many lines were omitted in between.
 *
 * @param content The multi-line string to truncate
 * @param lineLimit Optional maximum number of lines to keep. If not provided or 0, returns the original content
 * @returns The truncated string with an indicator of omitted lines, or the original content if no truncation needed
 *
 * @example
 * // With 10 line limit on 25 lines of content:
 * // - Keeps first 2 lines (20% of 10)
 * // - Keeps last 8 lines (80% of 10)
 * // - Adds "[...15 lines omitted...]" in between
 */
export function truncateOutput(content: string, lineLimit?: number): string {
	if (!lineLimit) {
		return content
	}

	// Count total lines
	let totalLines = 0
	let pos = -1
	while ((pos = content.indexOf("\n", pos + 1)) !== -1) {
		totalLines++
	}
	totalLines++ // Account for last line without newline

	if (totalLines <= lineLimit) {
		return content
	}

	const beforeLimit = Math.floor(lineLimit * 0.2) // 20% of lines before
	const afterLimit = lineLimit - beforeLimit // remaining 80% after

	// Find start section end position
	let startEndPos = -1
	let lineCount = 0
	pos = 0
	while (lineCount < beforeLimit && (pos = content.indexOf("\n", pos)) !== -1) {
		startEndPos = pos
		lineCount++
		pos++
	}

	// Find end section start position
	let endStartPos = content.length
	lineCount = 0
	pos = content.length
	while (lineCount < afterLimit && (pos = content.lastIndexOf("\n", pos - 1)) !== -1) {
		endStartPos = pos + 1 // Start after the newline
		lineCount++
	}

	const omittedLines = totalLines - lineLimit
	const startSection = content.slice(0, startEndPos + 1)
	const endSection = content.slice(endStartPos)
	return startSection + `\n[...${omittedLines} lines omitted...]\n\n` + endSection
}

/**
 * Applies run-length encoding to compress repeated lines in text.
 * Only compresses when the compression description is shorter than the repeated content.
 *
 * @param content The text content to compress
 * @returns The compressed text with run-length encoding applied
 */
export function applyRunLengthEncoding(content: string): string {
	if (!content) {
		return content
	}

	let result = ""
	let pos = 0
	let repeatCount = 0
	let prevLine = null
	let firstOccurrence = true

	while (pos < content.length) {
		const nextNewlineIdx = content.indexOf("\n", pos)
		const currentLine = nextNewlineIdx === -1 ? content.slice(pos) : content.slice(pos, nextNewlineIdx + 1)

		if (prevLine === null) {
			prevLine = currentLine
		} else if (currentLine === prevLine) {
			repeatCount++
		} else {
			if (repeatCount > 0) {
				const compressionDesc = `<previous line repeated ${repeatCount} additional times>\n`
				if (compressionDesc.length < prevLine.length * (repeatCount + 1)) {
					result += prevLine + compressionDesc
				} else {
					for (let i = 0; i <= repeatCount; i++) {
						result += prevLine
					}
				}
				repeatCount = 0
			} else {
				result += prevLine
			}
			prevLine = currentLine
		}

		pos = nextNewlineIdx === -1 ? content.length : nextNewlineIdx + 1
	}

	if (repeatCount > 0 && prevLine !== null) {
		const compressionDesc = `<previous line repeated ${repeatCount} additional times>\n`
		if (compressionDesc.length < prevLine.length * repeatCount) {
			result += prevLine + compressionDesc
		} else {
			for (let i = 0; i <= repeatCount; i++) {
				result += prevLine
			}
		}
	} else if (prevLine !== null) {
		result += prevLine
	}

	return result
}

/**
 * Processes carriage returns in terminal output to simulate how a real terminal would display content.
 * This function is optimized for performance by using in-place string operations and avoiding memory-intensive
 * operations like split/join.
 *
 * Key features:
 * 1. Processes output line-by-line to maximize chunk processing
 * 2. Uses string indexes and substring operations instead of arrays
 * 3. Single-pass traversal of the entire input
 * 4. Special handling for multi-byte characters (like emoji) to prevent corruption
 * 5. Replacement of partially overwritten multi-byte characters with spaces
 *
 * @param input The terminal output to process
 * @returns The processed terminal output with carriage returns handled
 */
export function processCarriageReturns(input: string): string {
	// Quick check: if no carriage returns, return the original input
	if (input.indexOf("\r") === -1) return input

	let output = ""
	let i = 0
	const len = input.length

	// Single-pass traversal of the entire input
	while (i < len) {
		// Find current line's end position (newline or end of text)
		let lineEnd = input.indexOf("\n", i)
		if (lineEnd === -1) lineEnd = len

		// Check if current line contains carriage returns
		let crPos = input.indexOf("\r", i)
		if (crPos === -1 || crPos >= lineEnd) {
			// No carriage returns in this line, copy entire line
			output += input.substring(i, lineEnd)
		} else {
			// Line has carriage returns, handle overwrite logic
			let curLine = input.substring(i, crPos)

			while (crPos < lineEnd) {
				// Find next carriage return or line end
				let nextCrPos = input.indexOf("\r", crPos + 1)
				if (nextCrPos === -1 || nextCrPos >= lineEnd) nextCrPos = lineEnd

				// Extract segment after carriage return
				let segment = input.substring(crPos + 1, nextCrPos)

				// Skip empty segments
				if (segment !== "") {
					// Determine how to handle overwrite
					if (segment.length >= curLine.length) {
						// Complete overwrite
						curLine = segment
					} else {
						// Partial overwrite - need to check for multi-byte character boundary issues
						const potentialPartialChar = curLine.charAt(segment.length)
						const segmentLastCharCode = segment.length > 0 ? segment.charCodeAt(segment.length - 1) : 0
						const partialCharCode = potentialPartialChar.charCodeAt(0)

						// Simplified condition for multi-byte character detection
						if (
							(segmentLastCharCode >= 0xd800 && segmentLastCharCode <= 0xdbff) || // High surrogate at end of segment
							(partialCharCode >= 0xdc00 && partialCharCode <= 0xdfff) || // Low surrogate at overwrite position
							(curLine.length > segment.length + 1 &&
								partialCharCode >= 0xd800 &&
								partialCharCode <= 0xdbff) // High surrogate followed by another character
						) {
							// If a partially overwritten multi-byte character is detected, replace with space
							const remainPart = curLine.substring(segment.length + 1)
							curLine = segment + " " + remainPart
						} else {
							// Normal partial overwrite
							curLine = segment + curLine.substring(segment.length)
						}
					}
				}

				crPos = nextCrPos
			}

			output += curLine
		}

		// Add newline if not at end of text
		if (lineEnd < len) output += "\n"

		// Move to next line
		i = lineEnd + 1
	}

	return output
}
