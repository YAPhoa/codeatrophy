Elevation map as an array of bar heights, width 1 each. How much water is trapped after rain?

`0 1 0 2 1 0 1 3 2 1 2 1` → `6`

Remember there being a two-pointer solution that beats the prefix-max / suffix-max arrays on memory. Water above bar $i$ is $\min(\text{maxLeft}_i, \text{maxRight}_i) - h_i$.
