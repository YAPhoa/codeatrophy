-- A large test case keeps the generator that printed its input: a program
-- that reads nothing and prints the stdin. Both columns are NULL for a case
-- without one, which every existing case starts as; stdin is stored either
-- way, so nothing needs to run the generator again.

ALTER TABLE test_cases
    ADD COLUMN generator_language text COLLATE "C",
    ADD COLUMN generator_source bytea,
    ADD CONSTRAINT test_cases_generator CHECK ((generator_source IS NULL) = (generator_language IS NULL));
