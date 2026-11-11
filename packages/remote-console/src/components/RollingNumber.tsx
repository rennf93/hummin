/**
 * components/RollingNumber: split-flap numeric readout, the dashboard's
 * RollingNumber ported to TSX. Each digit renders as a 0-9 column translated
 * to the target digit; columns transition on the motion tokens with a
 * per-position stagger (--rc-stagger times the index, so it is zero when motion
 * is off). Keys are position-stable: keying on the digit itself
 * would remount the column on every change and skip the transition entirely.
 * The render is aria-hidden: callers carry the accessible label.
 */
/// <reference lib="dom" />
import type { CSSProperties } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function RollingNumber({ value }: { value: number | null }) {
	const text = value === null || !Number.isFinite(value) ? "--" : value.toFixed(0);
	return (
		<span className="rc-roll" aria-hidden="true">
			{text.split("").map((char, index) =>
				/\d/.test(char) ? (
					<span key={index} className="rc-roll-digit">
						<span
							className="rc-roll-column"
							style={{ transform: `translateY(-${Number(char)}em)`, "--roll-index": index } as CSSProperties}
						>
							{DIGITS.map((digit) => (
								<span key={digit} className="rc-roll-cell">
									{digit}
								</span>
							))}
						</span>
					</span>
				) : (
					<span key={index} className="rc-roll-char">
						{char}
					</span>
				),
			)}
		</span>
	);
}
