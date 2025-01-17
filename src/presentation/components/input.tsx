import cx from 'classnames';
import type { FormikProps } from 'formik';

interface InputProps<FormValues> extends FormikProps<FormValues> {
  name: keyof FormValues;
  placeholder?: string;
  title?: string;
  type: 'text' | 'password';
  inputSuffix?: string;
  value?: string;
}

/**
 * Generic Formik Input
 */
export default function Input<FormValues>({
  errors,
  name,
  placeholder = '',
  title,
  touched,
  type = 'text',
  handleChange,
  handleBlur,
  inputSuffix,
  value,
}: InputProps<FormValues>) {
  return (
    <div>
      <label className="block text-left">
        {title && <p className="mb-2 font-medium">{title}</p>}
        <div className="relative">
          <input
            className={cx(
              'border-2 focus:ring-primary focus:border-primary placeholder-grayLight block w-full sm:w-2/5 rounded-md',
              {
                'border-red': errors[name] && touched[name],
                'border-grayLight': !errors[name],
              }
            )}
            value={value}
            id={name.toString()}
            name={name.toString()}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder={placeholder}
            type={type}
          />
          {inputSuffix && (
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 text-base font-medium">
              {inputSuffix}
            </span>
          )}
        </div>
      </label>
      <p className="text-red h-10 mt-2 text-xs text-left">
        {errors?.[name] ? errors[name]?.toString() : ''}
      </p>
    </div>
  );
}
