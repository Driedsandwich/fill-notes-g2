export function validateSceneNames(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('invalid scene object')
  const marks = scene.marks ?? []
  if (!Array.isArray(marks)) throw new Error('invalid scene marks')
  for (const [i, mark] of marks.entries()) {
    if (typeof mark?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mark.name)) {
      throw new Error(`invalid scene mark name at index ${i}`)
    }
  }
}
