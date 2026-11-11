/**
 * components/RollingNumber: split-flap numeric readout, the dashboard's
 * RollingNumber ported to TSX. Each digit renders as a 0-9 column translated
 * to the target digit; columns transition on the motion tokens with a 30ms
 * stagger per position. Keys are position-stable: keying on the digit itself
 * would remount the column on every change and skip the transition entirely.
 * The render is aria-hidden: callers carry the accessible label.
 */
/// <reference lib="dom" />
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function RollingNumber({
	value,
	decimals = 0,
	className,
}: {
	value: number | null;
	decimals?: number;
	className?: string;
}) {
	const text =
		value === null || !Number.isFinite(value) ? "--" : value.toFixed(decimals);
	return (
		<span className={className === undefined ? "rc-roll" : `rc-roll ${className}`} aria-hidden="true">
			{text.split("").map((char, index) =>
				/\d/.test(char) ? (
					<span key={index} className="rc-roll-digit">
						<span
							className="rc-roll-column"
							style={{ transform: `translateY(-${Number(char)}em)`, transitionDelay: `${index * 30}ms` }}
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
