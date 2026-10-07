/** Deduplicate memory records by id, keeping the first unseen record in input order without mutating inputs. */
export function uniqueNewRecords<T extends { id: string }>(records: readonly T[], existingIds: Iterable<string>): T[] {
	const seen = new Set(existingIds);
	return records.filter((record) => {
		if (seen.has(record.id)) {
			return false;
		}
		seen.add(record.id);
		return true;
	});
}
