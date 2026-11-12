-- Style preset names are a single line: no newline or tab.

UPDATE style_presets
SET name = trim(replace(replace(name, char(10), ' '), char(9), ' ')),
    name_key = lower(trim(replace(replace(name, char(10), ' '), char(9), ' ')))
WHERE instr(name, char(10)) > 0 OR instr(name, char(9)) > 0;

CREATE TRIGGER style_presets_name_single_line_insert BEFORE INSERT ON style_presets
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'style preset name must be a single line');
END;

CREATE TRIGGER style_presets_name_single_line_update BEFORE UPDATE OF name ON style_presets
WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
BEGIN
    SELECT RAISE(ABORT, 'style preset name must be a single line');
END;
