"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function TransactionSort({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger aria-label="Sort transactions" className="h-10! w-auto min-w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
                <SelectItem value="date_desc">Newest first</SelectItem>
                <SelectItem value="date_asc">Oldest first</SelectItem>
                <SelectItem value="amount_desc">Highest amount</SelectItem>
                <SelectItem value="amount_asc">Lowest amount</SelectItem>
            </SelectContent>
        </Select>
    );
}
