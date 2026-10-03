import { HttpError } from '../errors.js';

export default function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      throw new HttpError(422, 'validation_error', 'Invalid request', details);
    }
    req.body = parsed.data; // fields not in the schema are dropped here
    next();
  };
}
