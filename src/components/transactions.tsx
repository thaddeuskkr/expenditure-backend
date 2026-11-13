"use client";

import { Ellipsis } from "lucide-react";
import { Button } from "./ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { CategoryIcon } from "./category-icon";
import { EmptyState } from "./empty-state";
import { useWorkspace } from "./workspace-context";
import { categoryLabel,
    convertAmount,
    dayLabel,
    money,
    rateDate,
    timeLabel,
    isCircleTransaction,
    transactionName,
    transactionAmount,
    recurrenceLabel,
    recurrenceFrequencyLabel,
    type Transaction,
    type CircleTransaction,
    type Expense,
} from "@/lib/domain";

export function Transactions({
    rows,
    timezone,
    onView,
    onEdit,
    onDelete,
    onMove,
    onCircle,
    emptyAction,
    filtered = false,
}: {
    rows: Transaction[];
    onCircle?: (transaction: CircleTransaction) => void;
    timezone: string;
    onView: (expense: Expense) => void;
    onEdit: (expense: Expense) => void;
    onDelete: (expense: Expense) => void;
    onMove: (expense: Expense) => void;
    emptyAction: () => void;
    filtered?: boolean;
}) {
    const { preferences } = useWorkspace();
    if (!rows.length)
        return (
            <EmptyState
                title={filtered ? "No matching transactions" : "No transactions"}
                detail={
                    filtered ?
                        "Try a different search or category." :
                        "Add an expense to start tracking."
                }
                action={filtered ? undefined : "Add an expense"}
                onAction={emptyAction}
            />
        );
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left">
                <thead>
                    <tr className="border-b text-[9px] tracking-wider text-muted-foreground">
                        <th className="pb-3 font-normal">SOURCE / MERCHANT</th>
                        <th className="hidden pb-3 font-normal md:table-cell">CATEGORY</th>
                        <th className="hidden pb-3 font-normal sm:table-cell">DATE & TIME</th>
                        <th className="pb-3 text-right font-normal">AMOUNT</th>
                        <th className="w-10 pb-3">
                            <span className="sr-only">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((expense) => {
                        const circle = isCircleTransaction(expense) ? expense : null;
                        const label = transactionName(expense);
                        const open = () => circle ? onCircle?.(circle) : onView(expense as Expense);
                        return (
                            <tr
                                key={`${expense.collectionName}:${expense.id}`}
                                className="group border-b border-border/60 transition-colors hover:bg-white/1.5">
                                <td className="py-4 pr-4">
                                    <button
                                        onClick={open}
                                        className="flex max-w-full items-center gap-3 text-left">
                                        <CategoryIcon category={categoryLabel(expense)} />
                                        <span className="min-w-0">
                                            <span className="block max-w-32 truncate text-xs sm:max-w-52" title={label}>
                                                {label}
                                            </span>
                                            <span className="mt-1 flex max-w-36 flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground sm:max-w-52">
                                                <span className="max-w-full truncate">
                                                    {circle ?
                                                        `Circle · ${circle.expand.circle.name}` :
                                                        expense.payment_method ||
                                                        (expense.source === "shortcut" ? "Via Shortcut" : expense.source === "api" ? "Via API" : "Manual entry")}
                                                </span>
                                                {expense.recurrence && <span className="shrink-0 whitespace-nowrap" title={recurrenceLabel(expense)}><span aria-hidden="true" className="mr-2">·</span>{recurrenceFrequencyLabel(expense)}</span>}
                                            </span>
                                            <span className="mt-1 block text-[9px] text-muted-foreground sm:hidden">
                                                {dayLabel(expense.occurred_at, timezone)} · {timeLabel(expense.occurred_at, timezone, preferences.time_format)}
                                            </span>
                                        </span>
                                    </button>
                                </td>
                                <td className="hidden pr-4 text-[10px] text-muted-foreground md:table-cell">
                                    <span className="rounded-md border border-white/5 bg-white/2 px-2 py-1">
                                        {circle?.budget_category_name || categoryLabel(expense)}
                                    </span>
                                </td>
                                <td className="hidden pr-4 text-[10px] text-muted-foreground sm:table-cell">
                                    <span className="block whitespace-nowrap">{dayLabel(expense.occurred_at, timezone)}</span>
                                    <span className="mt-1 block whitespace-nowrap tabular-nums">{timeLabel(expense.occurred_at, timezone, preferences.time_format)}</span>
                                </td>
                                <td className="text-right text-xs whitespace-nowrap tabular-nums">
                                    <div className={expense.kind === "income" ? "text-primary" : ""}>
                                        {expense.kind === "income" ? "+ " : ""}{money(transactionAmount(expense), expense.currency)}{" "}
                                        <span className="text-[9px] text-muted-foreground">
                                            {expense.currency}
                                        </span>
                                    </div>
                                    {circle && <div className="mt-1 text-[9px] text-muted-foreground">Your share</div>}
                                    <ConvertedAmount expense={expense} />
                                </td>
                                <td className="pl-2">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Actions for ${label}`}
                                                className="text-muted-foreground">
                                                <Ellipsis className="size-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="w-max max-w-(--radix-dropdown-menu-content-available-width) whitespace-nowrap">
                                            <DropdownMenuItem onClick={open}>View details</DropdownMenuItem>
                                            {!circle && (
                                                <>
                                                    <DropdownMenuItem onClick={() => onEdit(expense as Expense)}>
                                                        Edit {expense.kind}
                                                    </DropdownMenuItem>
                                                    {expense.kind === "expense" && <DropdownMenuItem onClick={() => onMove(expense as Expense)}>Move to Circle</DropdownMenuItem>}
                                                    <DropdownMenuItem
                                                        variant="destructive"
                                                        onClick={() => onDelete(expense as Expense)}>
                                                        Delete {expense.kind}
                                                    </DropdownMenuItem>
                                                </>
                                            )}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function ConvertedAmount({ expense }: { expense: Transaction }) {
    const { preferences, rates } = useWorkspace();
    const mainCurrency = preferences.currency;
    if (expense.currency === mainCurrency) return null;

    const convertedAmount = convertAmount(
        transactionAmount(expense),
        expense.currency,
        mainCurrency,
        rates,
    );
    const date = rateDate(expense.currency, mainCurrency, rates);
    const label = convertedAmount === null ?
        "Conversion unavailable" :
        `≈ ${money(convertedAmount, mainCurrency)} ${mainCurrency}`;

    return (
        <div
            className="mt-1 text-[10px] text-muted-foreground"
            title={`Rate date: ${date || "unavailable"}`}>
            {label}
        </div>
    );
}
