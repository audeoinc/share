-- 検証用サンプルの片付け。PROJECT は置換すること。
-- データセットごと消すので、他の用途と同居させていないか確認してから実行する。

DROP SCHEMA IF EXISTS `PROJECT.sample_mart` CASCADE;
DROP SCHEMA IF EXISTS `PROJECT.sample_src_apac` CASCADE;
DROP SCHEMA IF EXISTS `PROJECT.sample_src_amer` CASCADE;
DROP SCHEMA IF EXISTS `PROJECT.sample_src_emea` CASCADE;
