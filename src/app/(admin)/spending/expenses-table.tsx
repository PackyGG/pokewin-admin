"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DynamicDataSheetGrid,
  textColumn,
  floatColumn,
  keyColumn,
  isoDateColumn,
  createTextColumn,
} from "react-datasheet-grid";
import "react-datasheet-grid/dist/style.css";
import type { CellProps, Column } from "react-datasheet-grid";
import type { Operation } from "react-datasheet-grid/dist/types";
import type { ExpenseListItem } from "@/lib/queries/spending";
import {
  createExpense,
  updateExpenseField,
  deleteExpense,
} from "./actions";
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from "./constants";
import { SelectCell } from "./select-cell";
import { ComboboxCell } from "./combobox-cell";

type ExpenseRow = {
  id: string | null;
  date: string | null;
  description: string | null;
  amount: number | null;
  paidTo: string | null;
  paidBy: string | null;
  paymentMethod: string | null;
  category: string | null;
  notes: string | null;
};

function toRow(e: ExpenseListItem): ExpenseRow {
  return {
    id: e.id,
    date: e.date,
    description: e.description,
    amount: e.amount,
    paidTo: e.paidTo,
    paidBy: e.paidBy,
    paymentMethod: e.paymentMethod,
    category: e.category,
    notes: e.notes,
  };
}

function isRowReady(row: ExpenseRow): boolean {
  return !!(row.description && row.amount && row.amount > 0 && row.date && row.paidTo);
}

const selectColumn = (
  choices: readonly { value: string; label: string }[]
): Partial<Column<string | null, unknown, string>> => ({
  component: ({ rowData, setRowData, focus, stopEditing, active }) => (
    <SelectCell
      value={rowData}
      choices={choices}
      focus={focus}
      active={active}
      onChange={(val) => {
        setRowData(val);
        setTimeout(() => stopEditing({ nextRow: false }), 0);
      }}
    />
  ),
  keepFocus: false,
  disableKeys: true,
  deleteValue: () => null,
  copyValue: ({ rowData }) =>
    choices.find((c) => c.value === rowData)?.label ?? rowData ?? "",
  pasteValue: ({ value }) => {
    const match = choices.find(
      (c) =>
        c.value === value ||
        c.label.toLowerCase() === value.toLowerCase()
    );
    return match?.value ?? null;
  },
  isCellEmpty: ({ rowData }) => !rowData,
});

const comboboxColumn = (
  suggestions: readonly { value: string; label: string }[]
): Partial<Column<string | null, unknown, string>> => ({
  component: ({ rowData, setRowData, focus, stopEditing, active }) => (
    <ComboboxCell
      value={rowData}
      suggestions={suggestions}
      focus={focus}
      active={active}
      onChange={(val) => {
        setRowData(val);
        setTimeout(() => stopEditing({ nextRow: false }), 0);
      }}
    />
  ),
  deleteValue: () => null,
  copyValue: ({ rowData }) =>
    suggestions.find((s) => s.value === rowData)?.label ?? rowData ?? "",
  pasteValue: ({ value }) => {
    const match = suggestions.find(
      (s) =>
        s.value === value ||
        s.label.toLowerCase() === value.toLowerCase()
    );
    return match?.value ?? value;
  },
  isCellEmpty: ({ rowData }) => !rowData,
});

const categoryChoices = EXPENSE_CATEGORIES.map((c) => ({
  value: c.value,
  label: c.label,
}));

const paymentMethodChoices = PAYMENT_METHODS.map((m) => ({
  value: m.value,
  label: m.label,
}));

export function ExpensesTable({ data }: { data: ExpenseListItem[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<ExpenseRow[]>(() => data.map(toRow));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Track which new rows are being created to avoid duplicates
  const creatingRows = useRef(new Set<number>());

  // Sync rows when server data changes
  const dataIds = data.map((d) => d.id).join(",");
  const [prevDataIds, setPrevDataIds] = useState(dataIds);
  if (dataIds !== prevDataIds) {
    setPrevDataIds(dataIds);
    setRows(data.map(toRow));
    creatingRows.current.clear();
  }

  const columns: Partial<Column<ExpenseRow>>[] = useMemo(
    () => [
      {
        ...keyColumn("date", isoDateColumn),
        title: "Date",
        basis: 120,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn("description", textColumn),
        title: "Description",
        basis: 180,
        grow: 2,
        minWidth: 120,
      },
      {
        ...keyColumn("amount", floatColumn),
        title: "Amount ($)",
        basis: 110,
        grow: 1,
        minWidth: 80,
      },
      {
        ...keyColumn("paidTo", textColumn),
        title: "Paid To",
        basis: 140,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn(
          "paidBy",
          createTextColumn({ placeholder: "Who paid..." })
        ),
        title: "Paid By",
        basis: 120,
        grow: 1,
        minWidth: 80,
      },
      {
        ...keyColumn("paymentMethod", selectColumn(paymentMethodChoices)),
        title: "Method",
        basis: 120,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn("category", comboboxColumn(categoryChoices)),
        title: "Category",
        basis: 130,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn(
          "notes",
          createTextColumn({ placeholder: "Notes..." })
        ),
        title: "Notes",
        basis: 140,
        grow: 1,
        minWidth: 100,
      },
      {
        component: ({ deleteRow }: CellProps<ExpenseRow, unknown>) => (
          <button
            type="button"
            onClick={deleteRow}
            className="flex items-center justify-center w-full h-full text-muted-foreground hover:text-destructive transition-colors"
            title="Delete row"
          >
            ✕
          </button>
        ),
        title: " ",
        basis: 40,
        grow: 0,
        minWidth: 40,
        disableKeys: true,
      },
    ],
    []
  );

  const createRow = useCallback(
    (): ExpenseRow => ({
      id: null,
      date: new Date().toISOString().split("T")[0],
      description: null,
      amount: null,
      paidTo: null,
      paidBy: null,
      paymentMethod: "bank_transfer",
      category: "other",
      notes: null,
    }),
    []
  );

  // Flush a row when user navigates away — handles both creates and updates
  const flushRow = useCallback(
    (rowIndex: number) => {
      const row = rowsRef.current[rowIndex];
      if (!row) return;

      if (row.id) {
        // Existing row — persist any changed fields
        const original = data.find((d) => d.id === row.id);
        if (original) persistUpdate(row, original);
      } else {
        // New row — create if ready
        if (creatingRows.current.has(rowIndex)) return;
        if (!isRowReady(row)) return;
        creatingRows.current.add(rowIndex);
        persistCreate(row);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]
  );

  const prevRowRef = useRef<number | null>(null);
  const handleActiveCellChange = useCallback(
    ({ cell }: { cell: { col: number; row: number } | null }) => {
      const prevRow = prevRowRef.current;
      const newRow = cell?.row ?? null;
      if (prevRow !== null && prevRow !== newRow) {
        flushRow(prevRow);
      }
      prevRowRef.current = newRow;
    },
    [flushRow]
  );

  const handleChange = useCallback(
    (newRows: ExpenseRow[], operations: Operation[]) => {
      setRows(newRows);

      for (const op of operations) {
        if (op.type === "DELETE") {
          const deletedIds: string[] = [];
          for (let i = op.fromRowIndex; i < op.toRowIndex; i++) {
            const oldRow = rows[i];
            if (oldRow?.id) deletedIds.push(oldRow.id);
          }
          for (const id of deletedIds) {
            persistDelete(id);
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows]
  );

  async function persistCreate(row: ExpenseRow) {
    try {
      await createExpense({
        description: row.description!,
        amount: row.amount!,
        date: row.date!,
        paidTo: row.paidTo!,
        paidBy: row.paidBy ?? undefined,
        paymentMethod: row.paymentMethod ?? "bank_transfer",
        category: row.category ?? "other",
        notes: row.notes ?? undefined,
      });
      toast.success("Expense added");
      router.refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to create expense"
      );
    }
  }

  async function persistUpdate(
    row: ExpenseRow,
    original: ExpenseListItem
  ) {
    // Only update fields that changed AND have non-null values (required fields can't be null)
    const requiredFields = new Set(["description", "amount", "date", "paidTo", "paymentMethod", "category"]);
    const fields: [string, string | number | null][] = [];

    if (row.description !== original.description)
      fields.push(["description", row.description]);
    if (row.amount !== original.amount)
      fields.push(["amount", row.amount]);
    if (row.date !== original.date) fields.push(["date", row.date]);
    if (row.paidTo !== original.paidTo)
      fields.push(["paidTo", row.paidTo]);
    if (row.paidBy !== (original.paidBy ?? null))
      fields.push(["paidBy", row.paidBy]);
    if (row.paymentMethod !== original.paymentMethod)
      fields.push(["paymentMethod", row.paymentMethod]);
    if (row.category !== original.category)
      fields.push(["category", row.category]);
    if (row.notes !== (original.notes ?? null))
      fields.push(["notes", row.notes]);

    // Filter out null values for required fields — user cleared a required cell, skip it
    const validFields = fields.filter(
      ([field, value]) => !requiredFields.has(field) || value != null
    );

    for (const [field, value] of validFields) {
      try {
        await updateExpenseField(row.id!, field, value as string | number);
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : `Failed to update ${field}`
        );
        router.refresh();
        return;
      }
    }
    if (validFields.length > 0) {
      router.refresh();
    }
  }

  async function persistDelete(id: string) {
    try {
      await deleteExpense(id);
      toast.success("Expense deleted");
      router.refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to delete expense"
      );
      router.refresh();
    }
  }

  return (
    <div className="dsg-container">
      <DynamicDataSheetGrid
        value={rows}
        onChange={handleChange}
        columns={columns}
        createRow={createRow}
        autoAddRow
        rowKey="id"
        height={Math.min(Math.max(rows.length + 2, 5) * 40 + 40, 600)}
        rowHeight={40}
        headerRowHeight={36}
        onActiveCellChange={handleActiveCellChange}
      />
    </div>
  );
}
