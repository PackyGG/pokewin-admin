"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DynamicDataSheetGrid,
  textColumn,
  floatColumn,
  keyColumn,
  checkboxColumn,
  createTextColumn,
} from "react-datasheet-grid";
import "react-datasheet-grid/dist/style.css";
import type { CellProps, Column } from "react-datasheet-grid";
import type { Operation } from "react-datasheet-grid/dist/types";
import type { RecurringExpenseListItem } from "@/lib/queries/spending";
import {
  createRecurringExpense,
  updateRecurringExpenseField,
  deleteRecurringExpense,
  toggleRecurringExpense,
} from "./actions";
import { EXPENSE_CATEGORIES } from "./constants";
import { formatCurrency } from "@/lib/utils/format";
import { ComboboxCell } from "./combobox-cell";

type RecurringRow = {
  id: string | null;
  name: string | null;
  amount: number | null;
  category: string | null;
  notes: string | null;
  isActive: boolean;
};

function toRow(r: RecurringExpenseListItem): RecurringRow {
  return {
    id: r.id,
    name: r.name,
    amount: r.amount,
    category: r.category,
    notes: r.notes,
    isActive: r.isActive,
  };
}

function isRowReady(row: RecurringRow): boolean {
  return !!(row.name && row.amount && row.amount > 0);
}

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

export function RecurringTable({
  data,
}: {
  data: RecurringExpenseListItem[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RecurringRow[]>(() => data.map(toRow));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const creatingRows = useRef(new Set<number>());

  const dataIds = data.map((d) => d.id).join(",");
  const [prevDataIds, setPrevDataIds] = useState(dataIds);
  if (dataIds !== prevDataIds) {
    setPrevDataIds(dataIds);
    setRows(data.map(toRow));
    creatingRows.current.clear();
  }

  const activeTotal = rows
    .filter((r) => r.isActive && r.id)
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const columns: Partial<Column<RecurringRow>>[] = useMemo(
    () => [
      {
        ...keyColumn("name", textColumn),
        title: "Name",
        basis: 200,
        grow: 1,
        minWidth: 120,
      },
      {
        ...keyColumn("amount", floatColumn),
        title: "Amount/mo ($)",
        basis: 120,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn("category", comboboxColumn(categoryChoices)),
        title: "Category",
        basis: 140,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn(
          "notes",
          createTextColumn({ placeholder: "Notes..." })
        ),
        title: "Notes",
        basis: 180,
        grow: 1,
        minWidth: 100,
      },
      {
        ...keyColumn("isActive", checkboxColumn),
        title: "Active",
        basis: 70,
        grow: 0,
        minWidth: 60,
      },
      {
        component: ({ deleteRow }: CellProps<RecurringRow, unknown>) => (
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
    (): RecurringRow => ({
      id: null,
      name: null,
      amount: null,
      category: "subscriptions",
      notes: null,
      isActive: true,
    }),
    []
  );

  // Flush a row when user navigates away — handles both creates and updates
  const flushRow = useCallback(
    (rowIndex: number) => {
      const row = rowsRef.current[rowIndex];
      if (!row) return;

      if (row.id) {
        const original = data.find((d) => d.id === row.id);
        if (original) persistUpdate(row, original);
      } else {
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
    (newRows: RecurringRow[], operations: Operation[]) => {
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

  async function persistCreate(row: RecurringRow) {
    try {
      await createRecurringExpense({
        name: row.name!,
        amount: row.amount!,
        category: row.category ?? "subscriptions",
        notes: row.notes ?? undefined,
      });
      toast.success("Recurring expense added");
      router.refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to create recurring expense"
      );
    }
  }

  async function persistUpdate(
    row: RecurringRow,
    original: RecurringExpenseListItem
  ) {
    const requiredFields = new Set(["name", "amount", "category"]);
    const fields: [string, string | number | boolean | null][] = [];
    if (row.name !== original.name) fields.push(["name", row.name]);
    if (row.amount !== original.amount)
      fields.push(["amount", row.amount]);
    if (row.category !== original.category)
      fields.push(["category", row.category]);
    if (row.notes !== (original.notes ?? null))
      fields.push(["notes", row.notes]);
    if (row.isActive !== original.isActive)
      fields.push(["isActive", row.isActive]);

    // Skip null values for required fields
    const validFields = fields.filter(
      ([field, value]) => !requiredFields.has(field) || value != null
    );

    for (const [field, value] of validFields) {
      try {
        if (field === "isActive") {
          await toggleRecurringExpense(row.id!, value as boolean);
        } else {
          await updateRecurringExpenseField(
            row.id!,
            field,
            value as string | number | null
          );
        }
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : `Failed to update ${field}`
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
      await deleteRecurringExpense(id);
      toast.success("Recurring expense deleted");
      router.refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to delete"
      );
      router.refresh();
    }
  }

  return (
    <div className="space-y-3">
      <div className="dsg-container">
        <DynamicDataSheetGrid
          value={rows}
          onChange={handleChange}
          columns={columns}
          createRow={createRow}
          autoAddRow
          rowKey="id"
          height={Math.min(Math.max(rows.length + 2, 5) * 40 + 40, 500)}
          rowHeight={40}
          headerRowHeight={36}
          onActiveCellChange={handleActiveCellChange}
        />
      </div>
      {rows.some((r) => r.id) && (
        <p className="text-sm text-muted-foreground">
          Active monthly total:{" "}
          <span className="font-mono font-medium text-foreground">
            {formatCurrency(activeTotal)}
          </span>
        </p>
      )}
    </div>
  );
}
