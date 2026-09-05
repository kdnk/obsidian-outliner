# persistent indent guide should reopen and refold a saved branch

- applyState:

```md
- parent|
  - branch #folded
    - child
```

- clickGuide: {"line":1,"kind":"indent","prefix":""}
- assertNativeListBullet: {"line":1}
- assertState:

```md
- parent|
  - branch
    - child
```

- clickGuide: {"line":1,"kind":"indent","prefix":""}
- assertState:

```md
- parent|
  - branch #folded
    - child
```

# nested indent guide should target only the exact raw prefix ancestor

- applyState:

```md
- root|
  - group
    - alpha
      - alpha branch
        - alpha leaf
      - alpha sibling branch
        - alpha sibling leaf
    - beta branch
      - beta leaf
  - outside
    - outside leaf
```

- clickGuide: {"line":4,"kind":"indent","prefix":"    "}
- assertState:

```md
- root|
  - group
    - alpha
      - alpha branch #folded
        - alpha leaf
      - alpha sibling branch #folded
        - alpha sibling leaf
    - beta branch
      - beta leaf
  - outside
    - outside leaf
```

# outer guide should isolate folding to its current document chunk

- applyState:

```md
- first root
  - first branch
    - first leaf
- first leaf sibling

- second root|
  - second branch
    - second leaf
```

- clickGuide: {"line":1,"kind":"outer"}
- assertState:

```md
- first root #folded
  - first branch
    - first leaf
- first leaf sibling

- second root|
  - second branch
    - second leaf
```

# indent guide should move a selection out of every range it folds

- applyState:

```md
- parent
  - branch
    - |selected leaf
  - sibling branch
    - sibling leaf
```

- clickGuide: {"line":2,"kind":"indent","prefix":""}
- assertState:

```md
- parent
  - |branch #folded
    - selected leaf
  - sibling branch #folded
    - sibling leaf
```

# repeated indent guide cycles should return to the original state

- applyState:

```md
- parent|
  - branch one
    - child one
  - branch two
    - child two
```

- clickGuide: {"line":1,"kind":"indent","prefix":""}
- assertState:

```md
- parent|
  - branch one #folded
    - child one
  - branch two #folded
    - child two
```

- clickGuide: {"line":1,"kind":"indent","prefix":""}
- assertState:

```md
- parent|
  - branch one
    - child one
  - branch two
    - child two
```

- clickGuide: {"line":1,"kind":"indent","prefix":""}
- clickGuide: {"line":1,"kind":"indent","prefix":""}
- assertState:

```md
- parent|
  - branch one
    - child one
  - branch two
    - child two
```

# outer guide should span a nested note paragraph gap and later siblings

- applyState:

```md
- root
	- child
		- grandchild
		  first paragraph
		  
		  second paragraph
- sibling|
	- sibling child
```

- clickGuide: {"line":6,"kind":"outer"}
- assertState:

```md
- root #folded
	- child
		- grandchild
		  first paragraph
		  
		  second paragraph
- sibling| #folded
	- sibling child
```
