"""P1 step 2: is 0 NoData, real elevation, or both?

The ENVI header says "data ignore value = 0", but 0 m can also be real terrain.
We cannot tell from one number, so we look at WHERE the zeros are:
- NoData usually forms blobs or whole rows/columns (missing data areas).
- Real elevation at exactly 0 m is scattered: a zero surrounded by non-zeros.

A pixel is "isolated" if none of its 4 neighbours (up, down, left, right) is 0.
Only counts are printed, never the grid.
"""

import numpy as np

from prepare_data import load_raster


def main() -> None:
    grid = load_raster()
    zero = grid == 0
    n_zero = int(zero.sum())
    print(f"zero count     {n_zero}")
    print(f"share of grid  {100 * n_zero / grid.size:.6f} %")
    if n_zero == 0:
        print("no zeros at all: NoData value 0 never occurs in this file")
        return

    # Count zeros that have at least one zero neighbour (blob members).
    # np.pad adds a border of False so edge pixels have 4 neighbours too.
    padded = np.pad(zero, 1, constant_values=False)
    has_zero_neighbour = (
        padded[:-2, 1:-1] | padded[2:, 1:-1] | padded[1:-1, :-2] | padded[1:-1, 2:]
    )
    in_blob = int((zero & has_zero_neighbour).sum())
    isolated = n_zero - in_blob
    print(f"in a blob      {in_blob}  (have a zero neighbour)")
    print(f"isolated       {isolated}  (no zero neighbour)")

    rows = np.flatnonzero(zero.any(axis=1))
    cols = np.flatnonzero(zero.any(axis=0))
    print(f"zero rows      {rows.size} of {grid.shape[0]} (first {rows[0]}, last {rows[-1]})")
    print(f"zero columns   {cols.size} of {grid.shape[1]} (first {cols[0]}, last {cols[-1]})")

    full_rows = int(zero.all(axis=1).sum())
    full_cols = int(zero.all(axis=0).sum())
    print(f"all-zero rows  {full_rows}, all-zero columns {full_cols}")


if __name__ == "__main__":
    main()
