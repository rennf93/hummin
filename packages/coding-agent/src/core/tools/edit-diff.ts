/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * Search-space normalization: normalizeForFuzzyMatch plus leading whitespace
 * stripped from every line, so an oldText whose indentation differs from the
 * file still matches. Used only to LOCATE match regions. Replacement content
 * is built in normalizeForFuzzyMatch space with found ranges mapped back, and
 * line-anchored replacements are re-anchored to the file's indentation (see
 * adjustReplacementIndentation), so a whitespace-sloppy oldText can never
 * impose its own indentation on the file.
 */
function normalizeForFuzzyMatchSearch(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^[ \t]+/, ""))
		.join("\n");
}

/** One line of the search space with its position in replacement space. */
interface SearchSpaceLine {
	/** Line start offset in search space. */
	searchStart: number;
	/** Line start offset in replacement space. */
	replacementStart: number;
	/** Leading whitespace length in replacement space. */
	leading: number;
	/** Line content length in search space (leading whitespace already removed). */
	searchLength: number;
}

/**
 * Per-line coordinate table for mapping search-space offsets back to
 * replacement space. Built from the replacement-space content: each of its
 * lines maps to the same line in search space minus the leading whitespace.
 */
function buildSearchSpaceLines(replacementContent: string): SearchSpaceLine[] {
	const lines: SearchSpaceLine[] = [];
	let searchStart = 0;
	let replacementStart = 0;
	for (const line of replacementContent.split("\n")) {
		const match = /^[ \t]*/.exec(line);
		const leading = match ? match[0].length : 0;
		lines.push({ searchStart, replacementStart, leading, searchLength: line.length - leading });
		searchStart += line.length - leading + 1;
		replacementStart += line.length + 1;
	}
	return lines;
}

/** Leading whitespace run of one line (empty for blank lines). */
function leadingWhitespace(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Map a match range found in search space back to replacement space
 * (normalizeForFuzzyMatch output). A match starting mid-line keeps the
 * touched line's leading indentation, since that indentation precedes the
 * match. A match starting at a line start that consumes the whole first
 * search line replaces the indentation too; callers re-anchor the replacement
 * to the file's indentation (see adjustReplacementIndentation). A match
 * starting at the previous line's newline (oldText whose first line is
 * empty) anchors at that newline, so the touched line's indentation stays
 * inside the replaced region.
 */
function mapSearchRangeToReplacementSpace(
	lines: SearchSpaceLine[],
	searchIndex: number,
	searchLength: number,
): { index: number; matchLength: number } {
	const searchEnd = searchIndex + searchLength;
	let index = -1;
	let endIndex = -1;
	for (const line of lines) {
		const searchLineEnd = line.searchStart + line.searchLength;
		if (index === -1 && searchIndex < searchLineEnd) {
			if (searchIndex === line.searchStart - 1) {
				// The match begins at the newline that terminates the previous line
				// (oldText's first line is empty). That newline is one char before
				// this line in both spaces; the leading whitespace of this line is
				// part of the addressed line and must stay inside the region.
				index = line.replacementStart - 1;
			} else {
				const atLineStart = searchIndex === line.searchStart;
				const coversWholeLine = searchEnd >= searchLineEnd;
				index =
					line.replacementStart +
					(atLineStart && coversWholeLine ? 0 : line.leading + (searchIndex - line.searchStart));
			}
		}
		if (index !== -1 && searchEnd <= searchLineEnd) {
			endIndex = line.replacementStart + line.leading + (searchEnd - line.searchStart);
			break;
		}
	}
	// Unreachable for ranges produced by indexOf over the same string; fall
	// back to the identity mapping rather than corrupting the edit.
	if (index === -1 || endIndex === -1) return { index: searchIndex, matchLength: searchLength };
	return { index, matchLength: endIndex - index };
}

/**
 * Re-anchor a fuzzy replacement's indentation to the file.
 *
 * A fuzzy match that starts at a line start (or at the previous line's newline)
 * consumes the touched file line's leading whitespace. Inserting newText
 * verbatim would then impose the model's indentation on the file even though
 * the model's oldText demonstrably disagreed with the file about that
 * indentation. When the model kept its own baseline (its newText first-line
 * indent equals its oldText first-line indent), shift every newText line by
 * the file's baseline instead: the replacement lands at the file's depth with
 * the model's relative offsets preserved. When the model deliberately changed
 * its baseline between oldText and newText, or uses incompatible whitespace
 * (tabs vs spaces), leave newText verbatim. Mid-line matches never consume the
 * file's indentation and are returned unchanged.
 *
 * Returns newText unchanged whenever the case is not clearly a
 * wrong-baseline edit - the transformation must never make an edit worse.
 */
export function adjustReplacementIndentation(
	baseContent: string,
	matchIndex: number,
	oldText: string,
	newText: string,
): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const atNewline = baseContent[matchIndex] === "\n";
	const lineStart = atNewline ? matchIndex + 1 : Math.max(0, baseContent.lastIndexOf("\n", matchIndex - 1) + 1);
	if (!atNewline && lineStart !== matchIndex) return newText; // mid-line: file indentation already preserved
	// The oldText line aligned with the anchored file line: the first line,
	// except for a newline-anchored match where oldText's first line is the
	// empty line that produced the leading "\n" of the search text.
	const aligned = atNewline ? 1 : 0;
	if (atNewline && (oldLines.length < 2 || oldLines[0] !== "")) return newText;
	if (aligned >= oldLines.length || aligned >= newLines.length) return newText;
	const oldBaseline = leadingWhitespace(oldLines[aligned]);
	const newBaseline = leadingWhitespace(newLines[aligned]);
	// A different newText baseline means the model re-indents on purpose.
	if (newBaseline !== oldBaseline) return newText;
	const lineEnd = baseContent.indexOf("\n", lineStart);
	const fileLine = baseContent.slice(lineStart, lineEnd === -1 ? baseContent.length : lineEnd);
	const fileBaseline = leadingWhitespace(fileLine);
	if (newBaseline === fileBaseline) return newText; // model already matches the file
	let add = "";
	let remove = 0;
	if (fileBaseline.startsWith(newBaseline)) {
		add = fileBaseline.slice(newBaseline.length);
	} else if (newBaseline.startsWith(fileBaseline)) {
		remove = newBaseline.length - fileBaseline.length;
	} else {
		return newText; // mixed tabs/spaces: inherently ambiguous, stay verbatim
	}
	return newLines
		.map((line, i) => {
			if (i < aligned) return line; // lines before the anchor (the empty "\n" line) stay verbatim
			const leading = leadingWhitespace(line);
			if (leading.length === line.length) return line; // blank line: never pad it
			if (remove > 0) return leading.slice(Math.min(remove, leading.length)) + line.slice(leading.length);
			return add + line;
		})
		.join("\n");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Fuzzy matching ignores per-line leading indentation on top of the
 * normalizeForFuzzyMatch equivalences (trailing whitespace, Unicode
 * quotes/dashes/spaces). When fuzzy matching is used, the returned
 * contentForReplacement is the fuzzy-normalized version of the content and
 * index/matchLength are offsets into it, with the found range mapped back
 * from the indentation-insensitive search space so replacement keeps every
 * byte outside the matched region verbatim.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match: search in a space that also strips leading indentation
	// per line, then map the found range back onto normalizeForFuzzyMatch
	// space, which is what callers use to compute replacements.
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const searchContent = normalizeForFuzzyMatchSearch(fuzzyContent);
	const searchOldText = normalizeForFuzzyMatchSearch(normalizeForFuzzyMatch(oldText));
	const searchIndex = searchContent.indexOf(searchOldText);

	if (searchIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	const mapped = mapSearchRangeToReplacementSpace(
		buildSearchSpaceLines(fuzzyContent),
		searchIndex,
		searchOldText.length,
	);
	return {
		found: true,
		index: mapped.index,
		matchLength: mapped.matchLength,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string): number {
	const searchContent = normalizeForFuzzyMatchSearch(normalizeForFuzzyMatch(content));
	const searchOldText = normalizeForFuzzyMatchSearch(normalizeForFuzzyMatch(oldText));
	return searchContent.split(searchOldText).length - 1;
}

const NEAR_MISS_CONTEXT_LINES = 3;
const NEAR_MISS_MAX_LINE_CHARS = 200;

/** Dice coefficient over character bigrams; 1 for equal strings, 0 for empty. */
function bigramSimilarity(a: string, b: string): number {
	if (a.length < 2 || b.length < 2) return a === b && a.length > 0 ? 1 : 0;
	if (a === b) return 1;
	const gramsA = new Set<string>();
	for (let i = 0; i < a.length - 1; i++) gramsA.add(a.slice(i, i + 2));
	const gramsB = new Set<string>();
	for (let i = 0; i < b.length - 1; i++) gramsB.add(b.slice(i, i + 2));
	let overlap = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) overlap++;
	}
	return (2 * overlap) / (gramsA.size + gramsB.size);
}

/**
 * Locate the file region closest to a failed oldText, rendered as bounded
 * "path:line: text" lines, so an error can show what is actually there.
 * Probe: the first non-empty oldText line, scored against every content line
 * (exact containment wins, then bigram similarity). Returns null when either
 * side is blank.
 */
export function nearestMatchContext(content: string, oldText: string, path: string): string | null {
	const probe = oldText
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!probe) return null;
	const lines = content.split("\n");
	let bestIndex = -1;
	let bestScore = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const score = line.includes(probe) ? 1 : bigramSimilarity(line, probe);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}
	if (bestIndex === -1) return null;
	const start = Math.max(0, bestIndex - 1);
	const snippetLines = lines.slice(start, start + NEAR_MISS_CONTEXT_LINES);
	return snippetLines
		.map((line, offset) => {
			const lineNumber = start + offset + 1;
			const text = line.length > NEAR_MISS_MAX_LINE_CHARS ? `${line.slice(0, NEAR_MISS_MAX_LINE_CHARS)}…` : line;
			return `${path}:${lineNumber}: ${text}`;
		})
		.join("\n");
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, context: string | null): Error {
	const base =
		totalEdits === 1
			? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
			: `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
	return new Error(context ? `${base} Closest match in the file:\n\n${context}` : base);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	context: string | null,
): Error {
	const base =
		totalEdits === 1
			? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
			: `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`;
	return new Error(context ? `${base} First occurrence:\n\n${context}` : base);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(
				path,
				i,
				normalizedEdits.length,
				nearestMatchContext(normalizedContent, edit.oldText, path),
			);
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				occurrences,
				nearestMatchContext(normalizedContent, edit.oldText, path),
			);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			// Fuzzy matches that consume a file line's indentation re-anchor the
			// replacement to the file's baseline (see adjustReplacementIndentation);
			// exact matches stay verbatim by contract.
			newText: matchResult.usedFuzzyMatch
				? adjustReplacementIndentation(replacementBaseContent, matchResult.index, edit.oldText, edit.newText)
				: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Count added/removed lines between two contents without materializing a diff string.
 * Counts whole changed lines, matching countDiffStat semantics on a line diff.
 */
export function countLineChanges(oldContent: string, newContent: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const part of Diff.diffLines(oldContent, newContent)) {
		if (!part.added && !part.removed) continue;
		const lines = part.value.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		if (part.added) added += lines.length;
		else removed += lines.length;
	}
	return { added, removed };
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
